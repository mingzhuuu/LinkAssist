import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

const IconWrapper: React.FC<IconProps> = ({ size = 16, className = '', children, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    {children}
  </svg>
);

export const PlusIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </IconWrapper>
);

export const BluetoothIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5" />
  </IconWrapper>
);

export const UsbIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="10" cy="7" r="1" />
    <circle cx="10" cy="17" r="1" />
    <circle cx="14" cy="12" r="1" />
    <path d="M10 7v10" />
    <path d="M10 12h4" />
    <path d="M14 12v3" />
  </IconWrapper>
);

export const WifiIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <line x1="12" y1="20" x2="12.01" y2="20" />
  </IconWrapper>
);

export const ChevronDownIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="6 9 12 15 18 9" />
  </IconWrapper>
);

export const SignalIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M2 20h.01" />
    <path d="M7 20v-4" />
    <path d="M12 20v-8" />
    <path d="M17 20V8" />
    <path d="M22 4v16" />
  </IconWrapper>
);

export const TerminalIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </IconWrapper>
);

export const ChartIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </IconWrapper>
);

export const TableIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="3" y1="15" x2="21" y2="15" />
    <line x1="9" y1="3" x2="9" y2="21" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </IconWrapper>
);

export const TrashIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
  </IconWrapper>
);

export const RefreshIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </IconWrapper>
);

export const PlayIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polygon points="5 3 19 12 5 21 5 3"></polygon>
  </IconWrapper>
);

export const StopIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
  </IconWrapper>
);

export const SearchIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="11" cy="11" r="8"></circle>
    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </IconWrapper>
);

export const CloseIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </IconWrapper>
);

export const SendIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="22" y1="2" x2="11" y2="13"></line>
    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </IconWrapper>
);

export const SettingsIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </IconWrapper>
);

export const ChevronRightIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="9 18 15 12 9 6"></polyline>
  </IconWrapper>
);

export const CopyIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </IconWrapper>
);

export const DownloadIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7 10 12 15 17 10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  </IconWrapper>
);

export const LinkIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
  </IconWrapper>
);

export const ClockIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </IconWrapper>
);

export const EyeIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </IconWrapper>
);

export const EyeOffIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </IconWrapper>
);

export const EraserIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.8 1.4c.8-.8 2-.8 2.8 0l5 5c.8.8.8 2 0 2.8L11.4 20" />
    <line x1="18" y1="13" x2="11" y2="20" />
  </IconWrapper>
);

export const SaveIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </IconWrapper>
);

export const EditIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </IconWrapper>
);

export const MinimizeIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="5" y1="12" x2="19" y2="12" />
  </IconWrapper>
);

export const MaximizeIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="4" y="4" width="16" height="16" rx="1" />
  </IconWrapper>
);

export const RestoreIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="6" y="6" width="12" height="12" rx="1" />
    <path d="M8 6V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1" />
  </IconWrapper>
);

export const SidebarIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </IconWrapper>
);

export const CenterTopPanelIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="3" y1="4.5" x2="21" y2="4.5" />
  </IconWrapper>
);

export const CenterBottomPanelIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="14" x2="21" y2="14" />
    <line x1="3" y1="19.5" x2="21" y2="19.5" />
  </IconWrapper>
);

export const RightPanelIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="14" y1="3" x2="14" y2="21" />
    <line x1="19.5" y1="3" x2="19.5" y2="21" />
  </IconWrapper>
);

export const ImageIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </IconWrapper>
);

export const BarChartIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="12" y1="20" x2="12" y2="10" />
    <line x1="18" y1="20" x2="18" y2="4" />
    <line x1="6" y1="20" x2="6" y2="16" />
    <line x1="2" y1="20" x2="22" y2="20" />
  </IconWrapper>
);

export const GaugeIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M12 2a10 10 0 0 1 10 10" />
    <path d="M12 2a10 10 0 0 0-10 10" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 12L16 8" />
    <path d="M2 12h2M20 12h2M12 4V2" />
  </IconWrapper>
);

export const WaveformIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M2 12h3l2-7 3 14 3-10 2 5 2-2h5" />
  </IconWrapper>
);

export const GridIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </IconWrapper>
);

export const FilterIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </IconWrapper>
);

export const HashIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="3" x2="8" y2="21" />
    <line x1="16" y1="3" x2="14" y2="21" />
  </IconWrapper>
);

export const WrapIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M3 6h18" />
    <path d="M3 12h15a3 3 0 0 1 0 6h-4" />
    <polyline points="16 16 14 18 16 20" />
    <path d="M3 18h7" />
  </IconWrapper>
);

export const TextIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </IconWrapper>
);

export const ChevronUpIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="18 15 12 9 6 15" />
  </IconWrapper>
);

export const SplitIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
  </IconWrapper>
);

export const BookmarkIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </IconWrapper>
);

export const PopOutIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </IconWrapper>
);

export const DockIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polyline points="9 21 3 21 3 15" />
    <line x1="14" y1="10" x2="3" y2="21" />
    <path d="M6 11V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-6" />
  </IconWrapper>
);

export const PhoneIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="7" y="2" width="10" height="20" rx="2" />
    <line x1="11" y1="18" x2="13" y2="18" />
  </IconWrapper>
);

export const ComputerIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <line x1="8" y1="20" x2="16" y2="20" />
    <line x1="12" y1="16" x2="12" y2="20" />
  </IconWrapper>
);

export const WatchIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    <path d="M9 17v3a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-3" />
  </IconWrapper>
);

export const DisplayIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="9" y1="21" x2="15" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </IconWrapper>
);

export const RemoteIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="9" y="2" width="6" height="20" rx="3" />
    <circle cx="12" cy="7" r="1" />
    <circle cx="12" cy="11" r="1" />
    <circle cx="12" cy="15" r="1" />
  </IconWrapper>
);

export const GlassesIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="7" cy="13" r="3" />
    <circle cx="17" cy="13" r="3" />
    <line x1="10" y1="13" x2="14" y2="13" />
    <path d="M4 13H2m20 0h-2" />
  </IconWrapper>
);

export const TagIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M20 13l-7 7-9-9V4h7z" />
    <circle cx="8.5" cy="8.5" r="1" />
  </IconWrapper>
);

export const KeyIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="8" cy="12" r="3" />
    <path d="M11 12h10" />
    <path d="M18 12v-2" />
    <path d="M20 12v-2" />
  </IconWrapper>
);

export const MediaIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <polygon points="10 9 16 12 10 15" />
  </IconWrapper>
);

export const ThermometerIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z" />
    <line x1="12" y1="10" x2="12" y2="16" />
  </IconWrapper>
);

export const HeartIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M20.8 7.6a4.8 4.8 0 0 0-6.8 0L12 9.6l-2-2a4.8 4.8 0 0 0-6.8 6.8L12 23l8.8-8.6a4.8 4.8 0 0 0 0-6.8z" />
  </IconWrapper>
);

export const BloodPressureIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M12 22s-6-4.5-6-10a6 6 0 0 1 12 0c0 5.5-6 10-6 10z" />
    <line x1="12" y1="9" x2="12" y2="14" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </IconWrapper>
);

export const HidIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="3" y="6" width="10" height="12" rx="2" />
    <path d="M13 10h4a2 2 0 0 1 2 2v6" />
    <line x1="8" y1="9" x2="8" y2="15" />
  </IconWrapper>
);

export const SensorIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="12" cy="12" r="2" />
    <path d="M5 12a7 7 0 0 1 7-7" />
    <path d="M19 12a7 7 0 0 0-7-7" />
    <path d="M5 12a7 7 0 0 0 7 7" />
    <path d="M19 12a7 7 0 0 1-7 7" />
  </IconWrapper>
);

export const LightIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12v2h8v-2a7 7 0 0 0-4-12z" />
  </IconWrapper>
);

export const FanIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="12" cy="12" r="1.5" />
    <path d="M12 5c1.5 0 3 1.2 3 2.8S13.5 10 12 10" />
    <path d="M18.1 15.5c-.8 1.3-2.7 1.8-4 .9-1.4-.8-1.8-2.6-1-3.9" />
    <path d="M5.9 15.5c.8 1.3 2.7 1.8 4 .9 1.4-.8 1.8-2.6 1-3.9" />
  </IconWrapper>
);

export const HvacIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M12 3v18" />
    <path d="M5 7l14 10" />
    <path d="M19 7L5 17" />
  </IconWrapper>
);

export const LockIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </IconWrapper>
);

export const PowerIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <line x1="12" y1="2" x2="12" y2="12" />
    <path d="M6.3 5.3a8 8 0 1 0 11.4 0" />
  </IconWrapper>
);

export const SpeakerIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <polygon points="5 9 9 9 14 5 14 19 9 15 5 15" />
    <path d="M18 9a4 4 0 0 1 0 6" />
  </IconWrapper>
);

export const MicIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <line x1="12" y1="18" x2="12" y2="22" />
  </IconWrapper>
);

export const HeadphoneIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M4 13a8 8 0 0 1 16 0" />
    <rect x="3" y="12" width="4" height="8" rx="1" />
    <rect x="17" y="12" width="4" height="8" rx="1" />
  </IconWrapper>
);

export const GamepadIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M7 17h10a4 4 0 0 0 3.8-5l-1-3A4 4 0 0 0 16 6H8a4 4 0 0 0-3.8 3l-1 3A4 4 0 0 0 7 17z" />
    <line x1="9" y1="11" x2="9" y2="14" />
    <line x1="7.5" y1="12.5" x2="10.5" y2="12.5" />
    <circle cx="15.5" cy="11.5" r="1" />
    <circle cx="17.5" cy="13.5" r="1" />
  </IconWrapper>
);

export const GlucoseIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M12 3c3 4 6 7.2 6 10.2A6 6 0 0 1 6 13.2C6 10.2 9 7 12 3z" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </IconWrapper>
);

export const RunningIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="14" cy="4" r="2" />
    <path d="M10 21l2-6-3-2 2-4 3 2h3" />
    <path d="M7 14l-3 2" />
  </IconWrapper>
);

export const CyclingIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="6" cy="17" r="3" />
    <circle cx="18" cy="17" r="3" />
    <path d="M10 17l3-6 2 3h3" />
    <path d="M9 8h3" />
  </IconWrapper>
);

export const WeightIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M6 21h12a3 3 0 0 0 3-3V9a6 6 0 0 0-6-6h-6a6 6 0 0 0-6 6v9a3 3 0 0 0 3 3z" />
    <path d="M12 9l2 2" />
  </IconWrapper>
);

export const PulseIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M2 12h4l2-4 3 8 2-4h9" />
  </IconWrapper>
);

export const WheelchairIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <circle cx="9" cy="5" r="2" />
    <path d="M11 9h3l2 4" />
    <path d="M10 9l-1 5h4" />
    <circle cx="10" cy="17" r="4" />
    <path d="M14 17h5" />
  </IconWrapper>
);

export const InsulinIcon: React.FC<IconProps> = (props) => (
  <IconWrapper {...props}>
    <path d="M9 3l6 6" />
    <path d="M15 9l-8 8" />
    <path d="M7 17l-2 4" />
    <rect x="13" y="2" width="6" height="4" rx="1" />
  </IconWrapper>
);

