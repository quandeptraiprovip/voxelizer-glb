declare module 'react-plotly.js' {
  import React from 'react';

  interface PlotProps {
    data?: any[];
    layout?: any;
    config?: any;
    style?: React.CSSProperties;
    [key: string]: any;
  }

  const Plot: React.FC<PlotProps>;
  export default Plot;
}
