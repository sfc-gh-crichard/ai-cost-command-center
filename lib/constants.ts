/** App title — displayed in the nav header and browser tab */
export const APP_TITLE = "AI Cost Command Center"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

/**
 * Chart series colours. Snowflake blue leads, with hues either side of it that
 * stay distinguishable in both light and dark mode. Ordered so the first few
 * carry the most-used series.
 */
export const CHART_COLORS = [
  "#29b5e8", // Snowflake blue
  "#11567f", // deep blue
  "#7d44cf", // violet
  "#ff9f36", // amber
  "#2eb67d", // green
  "#e8508d", // pink
  "#75cdd7", // teal
  "#8c6cd4", // light violet
  "#d9534f", // red
  "#5c7cfa", // indigo
] as const

/** Colour for the AI series and the platform (non-AI) series. */
export const AI_COLOR = "#29b5e8"
/**
 * Platform (non-AI) series. Deliberately a mid-slate rather than the muted
 * foreground token: at slate-500 or darker the stacked area was invisible
 * against the dark-mode card background, so the series simply disappeared for
 * anyone in dark mode except at large spikes.
 */
export const PLATFORM_COLOR = "#94a3b8"

/** Selectable lookback windows. */
export const DATE_RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "12 months" },
] as const
