/**
 * Persona icon keys (`CoachPersonaCard.avatar`) to MUI icons. The registry
 * names an icon by key so the web carries no persona text; an unknown key
 * (a fork's new persona) falls back to a generic person.
 */
import type { SvgIconComponent } from '@mui/icons-material';
import SportsOutlinedIcon from '@mui/icons-material/SportsOutlined';
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import RoomServiceOutlinedIcon from '@mui/icons-material/RoomServiceOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlineOutlined';

const PERSONA_ICONS: Record<string, SvgIconComponent> = {
  whistle: SportsOutlinedIcon,
  military_tech: MilitaryTechOutlinedIcon,
  account_balance: AccountBalanceOutlinedIcon,
  query_stats: QueryStatsIcon,
  room_service: RoomServiceOutlinedIcon,
  campaign: CampaignOutlinedIcon,
  favorite: FavoriteBorderIcon,
};

export function personaIcon(avatar: string): SvgIconComponent {
  return PERSONA_ICONS[avatar] ?? PersonOutlineIcon;
}
