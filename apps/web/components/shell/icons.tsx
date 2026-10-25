import {
  Activity,
  Bell,
  Bot,
  Check,
  ChartColumn,
  FileText,
  Folders,
  Grid3x3,
  House,
  KeyRound,
  LayoutTemplate,
  Link2,
  MapPin,
  Palette,
  Reply,
  Settings,
  ShieldCheck,
  SquarePen,
  Star,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { NavIconName } from "../../lib/nav";

const ICONS: Record<NavIconName, LucideIcon> = {
  home: House,
  star: Star,
  edit: SquarePen,
  pin: MapPin,
  chart: ChartColumn,
  grid: Grid3x3,
  file: FileText,
  link: Link2,
  folder: Folders,
  reply: Reply,
  template: LayoutTemplate,
  users: Users,
  palette: Palette,
  key: KeyRound,
  shield: ShieldCheck,
  check: Check,
  bot: Bot,
  gear: Settings,
  bell: Bell,
  activity: Activity,
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden className={className} />;
}
