import { brandPath } from './brand-icons';

/**
 * Three icon sources, all copied verbatim — nothing here is hand-drawn.
 *
 * 1. **点赞 / 投币 / 收藏 / 分享** are B站's own toolbar icons, taken from the video page's
 *    `video-toolbar` component (jinkela/video/video.<hash>.js) and its rendered SVG
 *    (`.video-like-icon`, `.video-coin-icon`, `.video-fav-icon`, `.video-share-icon`).
 *    B站 ships a single glyph per action and flips the state with an `.on` class on the
 *    wrapper; we do the same, so the acted state is carried by the pill colour *and* its
 *    background/border (see `.action.<kind>.on`) plus the title text — not by colour alone.
 * 2. **设置 / 刷新 / 记录** come from **Bootstrap Icons v1.11.3** (MIT), copied from
 *    `bootstrap-icons/icons/<name>.svg`.
 */
export interface ActionIconProps {
  on: boolean;
  size?: number;
}

export interface IconProps {
  size?: number;
}

/** The toolbar icons read better one step larger than the previous 16px set. */
const ACTION_SIZE = 20;

/**
 * B站 视频页工具栏图标（viewBox 与路径原样取自 `.video-like-icon` / `.video-coin-icon` /
 * `.video-fav-icon` / `.video-share-icon`）。B站 只用一个字形，用外壳的 `.on` 类换状态，
 * 这里是同样的做法。
 */
const BILI_LIKE_VIEWBOX = '0 0 36 36';
const BILI_LIKE = 'M9.77234 30.8573V11.7471H7.54573C5.50932 11.7471 3.85742 13.3931 3.85742 15.425V27.1794C3.85742 29.2112 5.50932 30.8573 7.54573 30.8573H9.77234ZM11.9902 30.8573V11.7054C14.9897 10.627 16.6942 7.8853 17.1055 3.33591C17.2666 1.55463 18.9633 0.814421 20.5803 1.59505C22.1847 2.36964 23.243 4.32583 23.243 6.93947C23.243 8.50265 23.0478 10.1054 22.6582 11.7471H29.7324C31.7739 11.7471 33.4289 13.402 33.4289 15.4435C33.4289 15.7416 33.3928 16.0386 33.3215 16.328L30.9883 25.7957C30.2558 28.7683 27.5894 30.8573 24.528 30.8573H11.9911H11.9902Z';

const BILI_COIN_VIEWBOX = '0 0 28 28';
const BILI_COIN = 'M14.045 25.5454C7.69377 25.5454 2.54504 20.3967 2.54504 14.0454C2.54504 7.69413 7.69377 2.54541 14.045 2.54541C20.3963 2.54541 25.545 7.69413 25.545 14.0454C25.545 17.0954 24.3334 20.0205 22.1768 22.1771C20.0201 24.3338 17.095 25.5454 14.045 25.5454ZM9.66202 6.81624H18.2761C18.825 6.81624 19.27 7.22183 19.27 7.72216C19.27 8.22248 18.825 8.62807 18.2761 8.62807H14.95V10.2903C17.989 10.4444 20.3766 12.9487 20.3855 15.9916V17.1995C20.3854 17.6997 19.9799 18.1052 19.4796 18.1052C18.9793 18.1052 18.5738 17.6997 18.5737 17.1995V15.9916C18.5667 13.9478 16.9882 12.2535 14.95 12.1022V20.5574C14.95 21.0577 14.5444 21.4633 14.0441 21.4633C13.5437 21.4633 13.1382 21.0577 13.1382 20.5574V12.1022C11.1 12.2535 9.52148 13.9478 9.51448 15.9916V17.1995C9.5144 17.6997 9.10883 18.1052 8.60856 18.1052C8.1083 18.1052 7.70273 17.6997 7.70265 17.1995V15.9916C7.71158 12.9487 10.0992 10.4444 13.1382 10.2903V8.62807H9.66202C9.11309 8.62807 8.66809 8.22248 8.66809 7.72216C8.66809 7.22183 9.11309 6.81624 9.66202 6.81624Z';

const BILI_FAV_VIEWBOX = '0 0 28 28';
const BILI_FAV = 'M19.8071 9.26152C18.7438 9.09915 17.7624 8.36846 17.3534 7.39421L15.4723 3.4972C14.8998 2.1982 13.1004 2.1982 12.4461 3.4972L10.6468 7.39421C10.1561 8.36846 9.25639 9.09915 8.19315 9.26152L3.94016 9.91102C2.63155 10.0734 2.05904 11.6972 3.04049 12.6714L6.23023 15.9189C6.96632 16.6496 7.29348 17.705 7.1299 18.7605L6.39381 23.307C6.14844 24.6872 7.62063 25.6614 8.84745 25.0119L12.4461 23.0634C13.4276 22.4951 14.6544 22.4951 15.6359 23.0634L19.2345 25.0119C20.4614 25.6614 21.8518 24.6872 21.6882 23.307L20.8703 18.7605C20.7051 17.705 21.0339 16.6496 21.77 15.9189L24.9597 12.6714C25.9412 11.6972 25.3687 10.0734 24.06 9.91102L19.8071 9.26152Z';

const BILI_SHARE_VIEWBOX = '0 0 28 28';
const BILI_SHARE = 'M12.6058 10.3326V5.44359C12.6058 4.64632 13.2718 4 14.0934 4C14.4423 4 14.78 4.11895 15.0476 4.33606L25.3847 12.7221C26.112 13.3121 26.2087 14.3626 25.6007 15.0684C25.5352 15.1443 25.463 15.2144 25.3847 15.2779L15.0476 23.6639C14.4173 24.1753 13.4791 24.094 12.9521 23.4823C12.7283 23.2226 12.6058 22.8949 12.6058 22.5564V18.053C7.59502 18.053 5.37116 19.9116 2.57197 23.5251C2.47607 23.6489 2.00031 23.7769 2.00031 23.2122C2.00031 16.2165 3.90102 10.3326 12.6058 10.3326Z';

/** bootstrap-icons/icons/gear.svg */
const GEAR_INNER = 'M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492M5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0';
const GEAR_OUTER = 'M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115z';

/** bootstrap-icons/icons/arrow-clockwise.svg */
const REFRESH_ARC = 'M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z';
const REFRESH_HEAD = 'M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466';

/** bootstrap-icons/icons/journal-plus.svg */
const JOURNAL_BOX = 'M3 0h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v1H1V2a2 2 0 0 1 2-2';
const JOURNAL_SPINE = 'M1 5v-.5a.5.5 0 0 1 1 0V5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0V8h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1zm0 3v-.5a.5.5 0 0 1 1 0v.5h.5a.5.5 0 0 1 0 1h-2a.5.5 0 0 1 0-1z';
const JOURNAL_PLUS = 'M8 5.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V10a.5.5 0 0 1-1 0V8.5H6a.5.5 0 0 1 0-1h1.5V6a.5.5 0 0 1 .5-.5';

/** bootstrap-icons/icons/info-circle.svg */
const INFO_RING = 'M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14m0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16';
const INFO_MARK = 'm8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0';

/** bootstrap-icons/icons/cpu.svg */
const CPU = 'M5 0a.5.5 0 0 1 .5.5V2h1V.5a.5.5 0 0 1 1 0V2h1V.5a.5.5 0 0 1 1 0V2h1V.5a.5.5 0 0 1 1 0V2A2.5 2.5 0 0 1 14 4.5h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14a2.5 2.5 0 0 1-2.5 2.5v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14A2.5 2.5 0 0 1 2 11.5H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2A2.5 2.5 0 0 1 4.5 2V.5A.5.5 0 0 1 5 0m-.5 3A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 11.5 3zM5 6.5A1.5 1.5 0 0 1 6.5 5h3A1.5 1.5 0 0 1 11 6.5v3A1.5 1.5 0 0 1 9.5 11h-3A1.5 1.5 0 0 1 5 9.5zM6.5 6a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5z';

/** simple-icons@13 `notion`. */
const NOTION = 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z';

/** bootstrap-icons/icons/pencil-square.svg */
const PENCIL = 'M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z';
const PENCIL_SQUARE = 'M1 13.5A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5v-6a.5.5 0 0 0-1 0v6a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5H9a.5.5 0 0 0 0-1H2.5A1.5 1.5 0 0 0 1 2.5z';

interface SvgProps {
  size?: number;
  class?: string;
}

function svg(size: number | undefined, fallback: number, children: unknown, className = 'act-icon') {
  return (
    <svg class={className} width={size ?? fallback} height={size ?? fallback} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      {children as never}
    </svg>
  );
}

/** One B站 glyph; the acted state is the `.on` class on the action pill, exactly like B站. */
function biliGlyph(viewBox: string, d: string, size: number | undefined, on: boolean) {
  return (
    <svg
      class="act-icon"
      width={size ?? ACTION_SIZE}
      height={size ?? ACTION_SIZE}
      viewBox={viewBox}
      aria-hidden="true"
      fill="currentColor"
      data-state={on ? 'on' : 'off'}
    >
      <path d={d} fill-rule="evenodd" clip-rule="evenodd" />
    </svg>
  );
}

export function LikeIcon({ on, size }: ActionIconProps) {
  return biliGlyph(BILI_LIKE_VIEWBOX, BILI_LIKE, size, on);
}

export function CoinIcon({ on, size }: ActionIconProps) {
  return biliGlyph(BILI_COIN_VIEWBOX, BILI_COIN, size, on);
}

export function FavoriteIcon({ on, size }: ActionIconProps) {
  return biliGlyph(BILI_FAV_VIEWBOX, BILI_FAV, size, on);
}

export function ShareIcon({ on, size }: ActionIconProps) {
  return biliGlyph(BILI_SHARE_VIEWBOX, BILI_SHARE, size, on);
}

/** Settings: bootstrap `gear`. */
export function GearIcon({ size }: IconProps) {
  return svg(size, 20, (
    <>
      <path d={GEAR_OUTER} />
      <path d={GEAR_INNER} />
    </>
  ));
}

/** Refresh / re-check: bootstrap `arrow-clockwise`. */
export function RefreshIcon({ size }: IconProps) {
  return svg(size, 19, (
    <>
      <path d={REFRESH_ARC} />
      <path d={REFRESH_HEAD} />
    </>
  ));
}

/** Write a new note: bootstrap `journal-plus`. */
export function NotesIcon({ size }: IconProps) {
  return svg(size, 16, (
    <>
      <path d={JOURNAL_PLUS} />
      <path d={JOURNAL_BOX} />
      <path d={JOURNAL_SPINE} />
    </>
  ));
}

/** Details / info: bootstrap `info-circle`. */
export function InfoIcon({ size }: IconProps) {
  return svg(size, 15, (
    <>
      <path d={INFO_RING} />
      <path d={INFO_MARK} />
    </>
  ));
}

/** Generic provider mark for the AI row: bootstrap `cpu`. */
export function ProviderIcon({ size }: IconProps) {
  return svg(size, 15, <path d={CPU} />);
}

/**
 * The AI row's provider mark: the endpoint's own logo when we have it (see `brand-icons.ts`),
 * otherwise the generic bootstrap `cpu` for an unknown OpenAI-compatible endpoint.
 */
export function ProviderMark({ provider, size }: { provider: string; size?: number }) {
  const brand = brandPath(provider);
  return (
    <svg
      class="act-icon"
      width={size ?? 14}
      height={size ?? 14}
      viewBox={brand ? '0 0 24 24' : '0 0 16 16'}
      aria-hidden="true"
      fill="currentColor"
    >
      <path d={brand ?? CPU} />
    </svg>
  );
}

/**
 * Notion's own logo, from **Simple Icons** (simple-icons@13 `notion`, viewBox 0 0 24 24).
 * The word "Notion" is a trademark of Notion Labs; it is used here only to label the Notion
 * integration, which is nominative use.
 */
export function NotionIcon({ size }: IconProps) {
  return (
    <svg class="act-icon" width={size ?? 15} height={size ?? 15} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d={NOTION} />
    </svg>
  );
}

/**
 * File-format badge for the SRT download. No icon set has an SRT glyph, so this is the file
 * extension itself (the same way an `.srt` chip is shown in a file manager).
 */
export function SrtIcon() {
  return (
    <span class="file-badge" aria-hidden="true">
      SRT
    </span>
  );
}

/** Add to an existing note: bootstrap `pencil-square`. */
export function WriteIcon({ size }: IconProps) {
  return svg(size, 16, (
    <>
      <path d={PENCIL} />
      <path d={PENCIL_SQUARE} />
    </>
  ));
}
