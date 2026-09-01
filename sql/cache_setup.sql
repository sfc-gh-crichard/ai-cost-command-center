/* ===================================================================
 * AI Cost Command Center — aggregate cache
 * ===================================================================
 *
 * WHY THIS EXISTS
 *
 * Querying SNOWFLAKE.ACCOUNT_USAGE directly made the app unusable. Measured
 * round-trips before this cache existed:
 *
 *   /api/cost/summary              31.9 s
 *   /api/cost/workloads            17.5 s
 *   /api/cost/product?key=coco     58.4 s
 *
 * ACCOUNT_USAGE views are slow irrespective of the window being asked for, so
 * no amount of client-side work fixes it. These tables precompute the same
 * aggregates on a schedule; the app then reads small local tables.
 *
 * DESIGN NOTES
 *
 * - Every table carries USAGE_DATE, so a single table serves all five lookback
 *   windows. Caching per window would multiply the tables and still not cover
 *   an arbitrary range.
 *
 * - CREATE OR REPLACE TABLE ... AS SELECT is atomic in Snowflake: readers see
 *   the previous table until the new one commits, so no separate swap step is
 *   needed and the app never observes a half-populated table.
 *
 * - Each table rebuild sits in its own BEGIN/EXCEPTION block. One failing
 *   source view should degrade a single panel, not abandon the whole refresh,
 *   and REFRESH_LOG records exactly which parts succeeded.
 *
 * - All windows anchor to UTC via CONVERT_TIMEZONE, never CURRENT_DATE.
 *   ACCOUNT_USAGE reports on a UTC basis while CURRENT_DATE is session-local;
 *   mixing the two previously produced a 32-day "30 day" window and made the
 *   same product report different totals on different tabs.
 *
 * - RETENTION_DAYS bounds every rebuild. Without it the cost of a full refresh
 *   grows with account age for data no window can reach. It is set to 420
 *   against a maximum requestable window of 400 days, deliberately: at exactly
 *   400 the retention predicate and the read window would be co-terminous, so a
 *   cache not rebuilt today would be short its oldest day.
 *
 * Run this file once with a role that can create tables, procedures and tasks in
 * the target schema, and that holds EXECUTE TASK on the account.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS LIVES
 *
 * The schema below is the only thing you need to change to relocate the cache.
 * If you use anything other than APPS.AI_COST_VIZ_APP, set the app's
 * COST_CACHE_SCHEMA environment variable to match (see app.yml), otherwise the
 * app will look for the tables in the default location, not find them, and fall
 * back to querying ACCOUNT_USAGE directly — correct, but slow.
 * ---------------------------------------------------------------------------
 */

CREATE DATABASE IF NOT EXISTS APPS;
CREATE SCHEMA IF NOT EXISTS APPS.AI_COST_VIZ_APP;
USE SCHEMA APPS.AI_COST_VIZ_APP;

/* ------------------------------------------------------------------
 * Tables
 * ------------------------------------------------------------------ */

-- Credits by UTC day and service type. The metering spine: authoritative for
-- account totals and the AI-vs-platform split.
CREATE TABLE IF NOT EXISTS AGG_DAILY_SERVICE (
  USAGE_DATE   DATE,
  SERVICE_TYPE VARCHAR,
  IS_AI        BOOLEAN,
  CREDITS      FLOAT
);

-- Per-user, per-product attribution. USER_LABEL and USER_TYPE are resolved at
-- refresh time so the app never has to join ACCOUNT_USAGE.USERS at read time.
-- USER_DETAIL carries secondary context, e.g. the database.schema of a dynamic
-- table whose refresh incurred the spend.
CREATE TABLE IF NOT EXISTS AGG_DAILY_USER_PRODUCT (
  USAGE_DATE  DATE,
  USER_NAME   VARCHAR,
  USER_LABEL  VARCHAR,
  USER_DETAIL VARCHAR,
  USER_TYPE   VARCHAR,
  PRODUCT_KEY VARCHAR,
  CREDITS     FLOAT
);

-- The secondary "by what" dimension, which differs per product: function and
-- model for AI functions, agent name for agents, surface for CoCo, service for
-- Cortex Search.
CREATE TABLE IF NOT EXISTS AGG_PRODUCT_BREAKDOWN (
  USAGE_DATE  DATE,
  PRODUCT_KEY VARCHAR,
  NAME        VARCHAR,
  DETAIL      VARCHAR,
  CREDITS     FLOAT,
  TOKENS      FLOAT
);

-- Most expensive individual AI workloads.
CREATE TABLE IF NOT EXISTS AGG_TOP_WORKLOADS (
  USAGE_DATE     DATE,
  QUERY_ID       VARCHAR,
  CREDITS        FLOAT,
  TOKENS         FLOAT,
  FUNCTION_NAME  VARCHAR,
  MODEL_NAME     VARCHAR,
  MODEL_COUNT    NUMBER,
  USER_NAME      VARCHAR,
  USER_LABEL     VARCHAR,
  USER_TYPE      VARCHAR,
  ROLE_NAME      VARCHAR,
  WAREHOUSE_NAME VARCHAR,
  START_TIME     TIMESTAMP_LTZ,
  ELAPSED_MS     FLOAT,
  QUERY_TEXT     VARCHAR
);

-- AI function credits by warehouse and by role, in one narrow table keyed by
-- DIMENSION so two panels share a single rebuild.
CREATE TABLE IF NOT EXISTS AGG_AI_BY_WAREHOUSE_ROLE (
  USAGE_DATE DATE,
  DIMENSION  VARCHAR,   -- 'WAREHOUSE' | 'ROLE'
  NAME       VARCHAR,
  CREDITS    FLOAT
);

-- One row per refresh attempt. Drives the "data through / refreshed" indicator
-- in the header, and is the only record of a partial failure.
CREATE TABLE IF NOT EXISTS REFRESH_LOG (
  REFRESHED_AT      TIMESTAMP_LTZ,
  STATUS            VARCHAR,   -- 'SUCCESS' | 'PARTIAL' | 'FAILED'
  DURATION_S        FLOAT,
  DATA_THROUGH_DATE DATE,
  ROW_COUNTS        VARIANT,
  ERROR_MESSAGE     VARCHAR,
  TRIGGERED_BY      VARCHAR    -- 'TASK' | user name for a manual refresh
);

/* ------------------------------------------------------------------
 * Refresh procedure
 * ------------------------------------------------------------------ */

CREATE OR REPLACE PROCEDURE SP_REFRESH_COST_CACHE(TRIGGERED_BY VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS OWNER
AS
$$
DECLARE
  RETENTION_DAYS INTEGER DEFAULT 420;
  started        TIMESTAMP_LTZ;
  errs           VARCHAR DEFAULT '';
  counts         VARCHAR DEFAULT '';
  n              INTEGER;
  through        DATE;
  final_status   VARCHAR;
BEGIN
  started := CURRENT_TIMESTAMP();

  -- ---------- 1. Metering spine ----------
  BEGIN
    CREATE OR REPLACE TABLE AGG_DAILY_SERVICE AS
    SELECT
      USAGE_DATE::DATE AS USAGE_DATE,
      SERVICE_TYPE,
      SERVICE_TYPE IN (
        'AI_FUNCTIONS','AI_SERVICES','AI_INFERENCE',
        'SNOWFLAKE_COCO_DESKTOP','SNOWFLAKE_COCO_CLI','SNOWFLAKE_COCO_SNOWSIGHT',
        'CORTEX_CODE_DESKTOP','CORTEX_CODE_CLI','CORTEX_CODE_SNOWSIGHT',
        'CORTEX_AGENTS','SNOWFLAKE_COWORK','SNOWFLAKE_INTELLIGENCE',
        'CORTEX_SEARCH','CORTEX_ANALYST',
        'CORTEX_DOCUMENT_PROCESSING','DOCUMENT_INTELLIGENCE',
        'CORTEX_FINE_TUNING','CORTEX_AI_GUARDRAILS','CORTEX_PROVISIONED_THROUGHPUT'
      ) AS IS_AI,
      SUM(CREDITS_USED) AS CREDITS
    FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY
    WHERE USAGE_DATE > DATEADD(day, -:RETENTION_DAYS,
                               CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3;

    SELECT COUNT(*) INTO :n FROM AGG_DAILY_SERVICE;
    counts := counts || '"AGG_DAILY_SERVICE":' || :n || ',';
  EXCEPTION
    WHEN OTHER THEN
      errs := errs || 'AGG_DAILY_SERVICE: ' || SQLERRM || ' | ';
  END;

  -- ---------- 2. Per-user, per-product ----------
  -- USER_DIM is resolved once here rather than at read time. Three quirks it
  -- handles:
  --
  --  1. CORTEX_ANALYST_USAGE_HISTORY reports LOGIN_NAME while the CoCo and agent
  --     views report NAME, so the same service account otherwise appears twice
  --     under different labels.
  --
  --  2. USER_ID = 0 is a sentinel for Snowflake-internal execution with no row in
  --     USERS at all. On this account it is the single largest line item, so
  --     bucketing it as "background jobs" left the top spender unexplained.
  --     Tracing QUERY_ID into QUERY_HISTORY shows it is entirely
  --     REFRESH_DYNAMIC_TABLE_AT_REFRESH_VERSION — dynamic tables calling
  --     AI_EXTRACT / AI_COMPLETE / AI_PARSE_DOCUMENT / AI_EMBED on their refresh
  --     schedule. The dynamic table's fully qualified name is embedded in a
  --     comment in the refresh SQL, so each pipeline is named individually
  --     instead of being pooled into one opaque row.
  --
  --  3. QUERY_HISTORY has its own retention, so a refresh whose query metadata
  --     has aged out still needs a sensible label rather than dropping out.
  BEGIN
    CREATE OR REPLACE TABLE AGG_DAILY_USER_PRODUCT AS
    WITH user_dim AS (
      SELECT
        USER_ID,
        NAME,
        LOGIN_NAME,
        COALESCE(NULLIF(DISPLAY_NAME, ''), NAME) AS LABEL,
        COALESCE(NULLIF(TYPE, ''), 'UNKNOWN')    AS USER_TYPE
      FROM SNOWFLAKE.ACCOUNT_USAGE.USERS
      WHERE DELETED_ON IS NULL
    ),
    raw AS (
      -- AI functions: USER_ID only, plus QUERY_HISTORY context for the
      -- USER_ID = 0 rows so automated pipelines can be named.
      --
      -- Every branch emits the RAW identity string only, never a display label.
      -- Resolution happens once in `resolved` below. Emitting a label here and
      -- then joining on it split one person into two rows (the same human
      -- appearing once under their account name and once under their display
      -- name) because the AI-function branch supplied the label while the CoCo
      -- branches supplied the account name.
      SELECT
        CONVERT_TIMEZONE('UTC', f.START_TIME)::DATE AS USAGE_DATE,
        d.NAME AS USER_NAME,
        (f.USER_ID = 0) AS IS_BACKGROUND,
        -- Fully qualified name of the dynamic table being refreshed, pulled from
        -- the /* DB.SCHEMA.NAME = */ comment Snowflake writes into refresh SQL.
        REGEXP_SUBSTR(qh.QUERY_TEXT, '/\\*\\s*([A-Za-z0-9_$."]+)\\s*=', 1, 1, 'e', 1)
          AS BG_OBJECT,
        qh.QUERY_TYPE AS BG_QUERY_TYPE,
        'ai_functions' AS PRODUCT_KEY,
        f.CREDITS AS CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f
      LEFT JOIN user_dim d ON d.USER_ID = f.USER_ID
      -- QUERY_HISTORY is unique on QUERY_ID (verified), so this cannot fan out.
      LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY qh
             ON qh.QUERY_ID = f.QUERY_ID AND f.USER_ID = 0
      WHERE CONVERT_TIMEZONE('UTC', f.START_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)

      UNION ALL
      SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, USER_NAME, FALSE, NULL, NULL, 'coco', TOKEN_CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
      WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)

      UNION ALL
      SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, USER_NAME, FALSE, NULL, NULL, 'coco', TOKEN_CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
      WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)

      UNION ALL
      SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, USER_NAME, FALSE, NULL, NULL, 'coco', TOKEN_CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
      WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)

      UNION ALL
      SELECT CONVERT_TIMEZONE('UTC', START_TIME)::DATE, USER_NAME, FALSE, NULL, NULL, 'agents', TOKEN_CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
      WHERE CONVERT_TIMEZONE('UTC', START_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)

      UNION ALL
      SELECT CONVERT_TIMEZONE('UTC', START_TIME)::DATE, USERNAME, FALSE, NULL, NULL, 'analyst', CREDITS
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_ANALYST_USAGE_HISTORY
      WHERE CONVERT_TIMEZONE('UTC', START_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    ),
    resolved AS (
      SELECT
        r.USAGE_DATE,
        CASE
          -- Key on the object's FQN so each pipeline is its own row.
          WHEN r.IS_BACKGROUND AND r.BG_OBJECT IS NOT NULL THEN r.BG_OBJECT
          WHEN r.IS_BACKGROUND THEN 'Automated refresh'
          -- Collapse a login name onto its canonical account name so one identity
          -- is one row. NAME is matched first; LOGIN_NAME only when NAME missed,
          -- which is what folds SF$SERVICE$... into MANAGED_SERVICE_1.
          ELSE COALESCE(bn.NAME, bl.NAME, r.USER_NAME, '(unattributed)')
        END AS USER_NAME_C,
        CASE
          -- Show just the object name; the database and schema go in USER_DETAIL
          -- so a long FQN does not crowd out the number beside it.
          WHEN r.IS_BACKGROUND AND r.BG_OBJECT IS NOT NULL
            THEN SPLIT_PART(r.BG_OBJECT, '.', -1)
          WHEN r.IS_BACKGROUND THEN 'Automated refresh'
          ELSE COALESCE(bn.LABEL, bl.LABEL, r.USER_NAME, '(unattributed)')
        END AS USER_LABEL_C,
        CASE
          WHEN r.IS_BACKGROUND AND r.BG_OBJECT IS NOT NULL
            THEN REGEXP_REPLACE(r.BG_OBJECT, '\\.[^.]+$', '')
          -- No QUERY_HISTORY match: say why rather than inventing a name.
          WHEN r.IS_BACKGROUND THEN 'scheduled job, details aged out of QUERY_HISTORY'
          ELSE NULL
        END AS USER_DETAIL_C,
        CASE
          WHEN r.IS_BACKGROUND
               AND r.BG_QUERY_TYPE ILIKE 'REFRESH_DYNAMIC_TABLE%' THEN 'DYNAMIC_TABLE'
          WHEN r.IS_BACKGROUND THEN 'AUTOMATION'
          ELSE COALESCE(bn.USER_TYPE, bl.USER_TYPE, 'UNKNOWN')
        END AS USER_TYPE_C,
        r.PRODUCT_KEY,
        r.CREDITS
      FROM raw r
      LEFT JOIN user_dim bn ON bn.NAME = r.USER_NAME
      LEFT JOIN user_dim bl ON bl.LOGIN_NAME = r.USER_NAME AND bn.NAME IS NULL
    )
    SELECT USAGE_DATE, USER_NAME_C AS USER_NAME, USER_LABEL_C AS USER_LABEL,
           USER_DETAIL_C AS USER_DETAIL, USER_TYPE_C AS USER_TYPE,
           PRODUCT_KEY, SUM(CREDITS) AS CREDITS
    FROM resolved
    GROUP BY 1, 2, 3, 4, 5, 6;

    SELECT COUNT(*) INTO :n FROM AGG_DAILY_USER_PRODUCT;
    counts := counts || '"AGG_DAILY_USER_PRODUCT":' || :n || ',';
  EXCEPTION
    WHEN OTHER THEN
      errs := errs || 'AGG_DAILY_USER_PRODUCT: ' || SQLERRM || ' | ';
  END;

  -- ---------- 3. Per-product breakdowns ----------
  BEGIN
    CREATE OR REPLACE TABLE AGG_PRODUCT_BREAKDOWN AS
    -- AI functions: AISQL carries the function/model detail. Note it describes
    -- the SAME spend as CORTEX_AI_FUNCTIONS_USAGE_HISTORY from another angle, so
    -- it is used for breakdown only and never added to a product total.
    SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE AS USAGE_DATE,
           'ai_functions' AS PRODUCT_KEY,
           FUNCTION_NAME AS NAME, MODEL_NAME AS DETAIL,
           SUM(TOKEN_CREDITS) AS CREDITS, SUM(TOKENS) AS TOKENS
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY
    WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
          > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4

    UNION ALL
    SELECT CONVERT_TIMEZONE('UTC', START_TIME)::DATE, 'agents',
           COALESCE(AGENT_NAME, '(unnamed)'),
           COALESCE(AGENT_DATABASE_NAME || '.' || AGENT_SCHEMA_NAME, '-'),
           SUM(TOKEN_CREDITS), SUM(TOKENS)
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
    WHERE CONVERT_TIMEZONE('UTC', START_TIME)::DATE
          > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4

    UNION ALL
    SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, 'coco', 'Desktop', '',
           SUM(TOKEN_CREDITS), SUM(TOKENS)
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_DESKTOP_USAGE_HISTORY
    WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
          > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4

    UNION ALL
    SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, 'coco', 'CLI', '',
           SUM(TOKEN_CREDITS), SUM(TOKENS)
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_CLI_USAGE_HISTORY
    WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
          > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4

    UNION ALL
    SELECT CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE, 'coco', 'Snowsight', '',
           SUM(TOKEN_CREDITS), SUM(TOKENS)
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_CODE_SNOWSIGHT_USAGE_HISTORY
    WHERE CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
          > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4

    UNION ALL
    SELECT USAGE_DATE::DATE, 'search', SERVICE_NAME,
           DATABASE_NAME || '.' || SCHEMA_NAME,
           SUM(CREDITS), SUM(TOKENS)
    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_SEARCH_DAILY_USAGE_HISTORY
    WHERE USAGE_DATE > DATEADD(day, -:RETENTION_DAYS,
                               CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    GROUP BY 1, 2, 3, 4;

    SELECT COUNT(*) INTO :n FROM AGG_PRODUCT_BREAKDOWN;
    counts := counts || '"AGG_PRODUCT_BREAKDOWN":' || :n || ',';
  EXCEPTION
    WHEN OTHER THEN
      errs := errs || 'AGG_PRODUCT_BREAKDOWN: ' || SQLERRM || ' | ';
  END;

  -- ---------- 4. Top workloads ----------
  -- AISQL has one row per (query, model, function), so it is pre-aggregated to
  -- one row per QUERY_ID BEFORE joining QUERY_HISTORY. Joining first would fan
  -- out the metadata and double-count credits for multi-model queries. The join
  -- is LEFT because QUERY_HISTORY has its own retention: an expensive workload
  -- should still be listed once its query metadata has aged out.
  BEGIN
    CREATE OR REPLACE TABLE AGG_TOP_WORKLOADS AS
    WITH user_dim AS (
      SELECT NAME, LOGIN_NAME,
             COALESCE(NULLIF(DISPLAY_NAME, ''), NAME) AS LABEL,
             COALESCE(NULLIF(TYPE, ''), 'UNKNOWN')    AS USER_TYPE
      FROM SNOWFLAKE.ACCOUNT_USAGE.USERS WHERE DELETED_ON IS NULL
    ),
    per_query AS (
      -- USAGE_DATE is the first UTC date the query was seen. Verified that zero
      -- QUERY_IDs span more than one UTC date on this account, so this is exact
      -- today. It is a latent divergence though: the live query filters rows to
      -- the window, whereas this filters whole queries by first-seen date, so a
      -- query straddling the window's lower bound would have its in-window
      -- credits counted live and dropped here.
      SELECT QUERY_ID,
             MIN(CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE) AS USAGE_DATE,
             SUM(TOKEN_CREDITS) AS CREDITS,
             SUM(TOKENS) AS TOKENS,
             MAX(FUNCTION_NAME) AS FUNCTION_NAME,
             MAX(MODEL_NAME) AS MODEL_NAME,
             COUNT(DISTINCT MODEL_NAME) AS MODEL_COUNT
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY
      WHERE QUERY_ID IS NOT NULL
        AND CONVERT_TIMEZONE('UTC', USAGE_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
      GROUP BY QUERY_ID
    )
    SELECT
      pq.USAGE_DATE, pq.QUERY_ID, pq.CREDITS, pq.TOKENS,
      pq.FUNCTION_NAME, pq.MODEL_NAME, pq.MODEL_COUNT,
      qh.USER_NAME,
      -- A dynamic table refresh runs as USER_NAME = 'SYSTEM', which tells the
      -- reader nothing. Where the refresh SQL names the object, show that
      -- instead so the row identifies the pipeline that actually spent it.
      CASE
        WHEN qh.QUERY_TYPE ILIKE 'REFRESH_DYNAMIC_TABLE%'
             AND REGEXP_SUBSTR(qh.QUERY_TEXT, '/\\*\\s*([A-Za-z0-9_$."]+)\\s*=', 1, 1, 'e', 1) IS NOT NULL
          THEN SPLIT_PART(
                 REGEXP_SUBSTR(qh.QUERY_TEXT, '/\\*\\s*([A-Za-z0-9_$."]+)\\s*=', 1, 1, 'e', 1),
                 '.', -1)
        ELSE COALESCE(d.LABEL, qh.USER_NAME)
      END AS USER_LABEL,
      CASE
        WHEN qh.QUERY_TYPE ILIKE 'REFRESH_DYNAMIC_TABLE%' THEN 'DYNAMIC_TABLE'
        ELSE COALESCE(d.USER_TYPE, 'UNKNOWN')
      END AS USER_TYPE,
      qh.ROLE_NAME, qh.WAREHOUSE_NAME, qh.START_TIME,
      qh.TOTAL_ELAPSED_TIME AS ELAPSED_MS,
      LEFT(qh.QUERY_TEXT, 300) AS QUERY_TEXT
    FROM per_query pq
    LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY qh ON qh.QUERY_ID = pq.QUERY_ID
    LEFT JOIN user_dim d ON d.NAME = qh.USER_NAME;

    SELECT COUNT(*) INTO :n FROM AGG_TOP_WORKLOADS;
    counts := counts || '"AGG_TOP_WORKLOADS":' || :n || ',';
  EXCEPTION
    WHEN OTHER THEN
      errs := errs || 'AGG_TOP_WORKLOADS: ' || SQLERRM || ' | ';
  END;

  -- ---------- 5. Warehouse and role ----------
  -- There is no ACCOUNT_USAGE.WAREHOUSES dimension view, so the ID-to-name map
  -- comes from WAREHOUSE_METERING_HISTORY, the only view carrying both columns.
  -- ROLE_NAMES is an ARRAY: credits are divided by ARRAY_SIZE after FLATTEN,
  -- otherwise a multi-role query is counted once per role and the total inflates.
  BEGIN
    CREATE OR REPLACE TABLE AGG_AI_BY_WAREHOUSE_ROLE AS
    WITH wh AS (
      SELECT WAREHOUSE_ID, MAX(WAREHOUSE_NAME) AS WAREHOUSE_NAME
      FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
      GROUP BY WAREHOUSE_ID
    ),
    src AS (
      SELECT f.*, CONVERT_TIMEZONE('UTC', f.START_TIME)::DATE AS UDATE
      FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY f
      WHERE CONVERT_TIMEZONE('UTC', f.START_TIME)::DATE
            > DATEADD(day, -:RETENTION_DAYS, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::DATE)
    )
    SELECT s.UDATE AS USAGE_DATE, 'WAREHOUSE' AS DIMENSION,
           COALESCE(wh.WAREHOUSE_NAME, '(none)') AS NAME,
           SUM(s.CREDITS) AS CREDITS
    FROM src s LEFT JOIN wh ON wh.WAREHOUSE_ID = s.WAREHOUSE_ID
    GROUP BY 1, 2, 3

    UNION ALL
    SELECT s.UDATE, 'ROLE', r.VALUE::STRING,
           SUM(s.CREDITS / GREATEST(ARRAY_SIZE(s.ROLE_NAMES), 1))
    FROM src s, LATERAL FLATTEN(input => s.ROLE_NAMES) r
    GROUP BY 1, 2, 3;

    SELECT COUNT(*) INTO :n FROM AGG_AI_BY_WAREHOUSE_ROLE;
    counts := counts || '"AGG_AI_BY_WAREHOUSE_ROLE":' || :n || ',';
  EXCEPTION
    WHEN OTHER THEN
      errs := errs || 'AGG_AI_BY_WAREHOUSE_ROLE: ' || SQLERRM || ' | ';
  END;

  -- ---------- Log the attempt ----------
  -- DATA_THROUGH_DATE is the newest day present in the data, which is what the
  -- header reports as "data through". It is deliberately distinct from
  -- REFRESHED_AT: a refresh that runs now still only sees data ACCOUNT_USAGE has
  -- caught up on, which lags by a few hours.
  through := NULL;
  BEGIN
    SELECT MAX(USAGE_DATE) INTO :through FROM AGG_DAILY_SERVICE;
  EXCEPTION
    WHEN OTHER THEN through := NULL;
  END;

  IF (errs = '') THEN
    final_status := 'SUCCESS';
  ELSEIF (counts = '') THEN
    final_status := 'FAILED';
  ELSE
    final_status := 'PARTIAL';
  END IF;

  INSERT INTO REFRESH_LOG
    (REFRESHED_AT, STATUS, DURATION_S, DATA_THROUGH_DATE, ROW_COUNTS, ERROR_MESSAGE, TRIGGERED_BY)
  SELECT
    CURRENT_TIMESTAMP(),
    :final_status,
    DATEDIFF(millisecond, :started, CURRENT_TIMESTAMP()) / 1000.0,
    :through,
    TRY_PARSE_JSON('{' || RTRIM(:counts, ',') || '}'),
    NULLIF(:errs, ''),
    COALESCE(:TRIGGERED_BY, 'UNKNOWN');

  RETURN final_status || ' in '
      || (DATEDIFF(millisecond, :started, CURRENT_TIMESTAMP()) / 1000.0)::VARCHAR
      || 's. ' || COALESCE(NULLIF(:errs, ''), '');
END;
$$;

/* ------------------------------------------------------------------
 * Hourly refresh task
 *
 * Serverless, so it needs no warehouse. Hourly at :15 past is the right cadence
 * because ACCOUNT_USAGE itself lags 1-3 hours — refreshing more often spends
 * credits without producing fresher data. The app also exposes a manual refresh
 * for when someone needs the newest available numbers immediately.
 * ------------------------------------------------------------------ */

CREATE OR REPLACE TASK TSK_REFRESH_COST_CACHE
  SCHEDULE = 'USING CRON 15 * * * * UTC'
  USER_TASK_TIMEOUT_MS = 900000
  COMMENT = 'Rebuilds the AI Cost Command Center aggregate cache.'
AS
  CALL SP_REFRESH_COST_CACHE('TASK');

-- Tasks are created suspended and do nothing until resumed.
ALTER TASK TSK_REFRESH_COST_CACHE RESUME;
