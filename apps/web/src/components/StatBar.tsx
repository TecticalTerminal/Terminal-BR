
import React from 'react';

interface StatBarProps {
  label: string;
  value: number;
  maxValue: number;
  color?: string;
}

export const StatBar: React.FC<StatBarProps> = ({ label, value, maxValue, color = 'bg-white' }) => {
  const percentage = Math.max(0, Math.min(100, (value / maxValue) * 100));
  const barLength = 25;
  const filledLength = Math.round((percentage / 100) * barLength);
  
  return (
    <div className="font-mono text-base mb-4">
      <div className="flex justify-between mb-2">
        <span className="uppercase font-black tracking-widest">{label}</span>
        <span className="font-bold">{value} <span className="opacity-30">/ {maxValue}</span></span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-lg opacity-40">[</span>
        <div className="flex-1 bg-black border-2 border-white/20 h-6 relative overflow-hidden">
          <div 
            className={`h-full ${color} transition-all duration-500 shadow-[0_0_15px_rgba(255,255,255,0.1)]`} 
            style={{ width: `${percentage}%` }}
          />
          <div className="absolute inset-0 flex">
            {Array.from({ length: barLength }).map((_, i) => (
              <div key={i} className="flex-1 border-r border-black/30 last:border-r-0" />
            ))}
          </div>
        </div>
        <span className="text-lg opacity-40">]</span>
      </div>
    </div>
  );
};
