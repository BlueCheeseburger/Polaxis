import React from 'react';

const PulsingCrosshairs = ({ size = 48, strokeWidth, className = '', label }) => {
  const stroke = strokeWidth ?? Math.max(1.5, size / 24);
  return (
    <span
      className={`pulsing-crosshairs ${className}`}
      role={label ? 'status' : undefined}
      aria-label={label}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle className="pc-ring" cx="24" cy="24" r="14" opacity="0.35" />
        <line className="pc-line pc-line-h" x1="6" y1="24" x2="42" y2="24" />
        <line className="pc-line pc-line-v" x1="24" y1="6" x2="24" y2="42" />
        <circle className="pc-dot" cx="24" cy="24" r="2.5" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
};

export default PulsingCrosshairs;
