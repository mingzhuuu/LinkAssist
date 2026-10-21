export function getChartTheme() {
  const isHighContrast = document.documentElement.classList.contains('high-contrast');
  const isHighContrastLight = document.documentElement.classList.contains('high-contrast-light');
  const isDark = document.documentElement.classList.contains('dark') || isHighContrast;
  
  if (isHighContrast) {
    return {
      axisStroke: 'rgba(255, 255, 255, 1)',
      gridStroke: 'rgba(255, 255, 255, 0.5)',
    };
  }

  if (isHighContrastLight) {
    return {
      axisStroke: 'rgba(0, 0, 0, 1)',
      gridStroke: 'rgba(0, 0, 0, 0.5)',
    };
  }
  
  return {
    axisStroke: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)',
    gridStroke: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
  };
}
