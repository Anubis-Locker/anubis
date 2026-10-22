/**
 * UI icon set: Lucide (ISC license, https://lucide.dev) exposed under the
 * same names/props as the @ant-design/icons components it replaces, so call
 * sites only need to change the import path.
 * Protocol/OS icons (@ai-security-tool/icons) and the terminal are untouched.
 */
import {
  Zap, LayoutGrid, BookOpen, CloudCog, Palette, Settings, CirclePlus, Info,
  CircleArrowUp, Crosshair, PanelLeftClose, Maximize2, Minimize2, Pin,
  SquareArrowOutUpRight, CirclePlay, CirclePause, List, ChartColumn, Languages,
  ChevronsRight, SquareFunction, History, Trash2, Copy, Ellipsis, Plus, Code,
  ArrowLeftToLine, ArrowDownToLine, ArrowUpToLine, SquareTerminal,
  SquareChevronRight, Bot, ChevronDown, ChevronLeft, ChevronRight,
  PanelsTopLeft, Grid2x2, Square, Loader, LoaderCircle, Minus, ArrowRight, Sun,
  Moon, CircleCheck, CircleX, TriangleAlert, Import, Upload, ArrowDown, ArrowUp,
  Save, Eraser, RotateCw, Diff, SquareMinus, ArrowLeftRight, ArrowLeft, Search,
  Clock, CircleMinus, Lock, SquarePen, X, Frown
} from 'lucide-react'

const STROKE = 1.75

if (typeof document !== 'undefined' && !document.getElementById('anubis-icon-css')) {
  const st = document.createElement('style')
  st.id = 'anubis-icon-css'
  st.textContent = '@keyframes anubis-icon-spin{to{transform:rotate(360deg)}}'
  document.head.appendChild(st)
}

function make (Icon, { filled = false, spin = false } = {}) {
  return function UiIcon ({ className = '', style, spin: spinProp, rotate, ...rest }) {
    const doSpin = spinProp === undefined ? spin : spinProp
    const st = {
      display: 'inline-flex',
      alignItems: 'center',
      lineHeight: 0,
      verticalAlign: '-0.125em',
      ...style
    }
    const svgStyle = doSpin
      ? { animation: 'anubis-icon-spin 1s linear infinite' }
      : (rotate ? { transform: `rotate(${rotate}deg)` } : undefined)
    return (
      <span
        role='img'
        className={`anticon ${className}`.trim()}
        style={st}
        {...rest}
      >
        <Icon
          size='1em'
          strokeWidth={STROKE}
          fill={filled ? 'currentColor' : 'none'}
          style={svgStyle}
        />
      </span>
    )
  }
}

export const AppstoreOutlined = make(LayoutGrid)
export const BookOutlined = make(BookOpen)
export const CloudSyncOutlined = make(CloudCog)
export const PictureOutlined = make(Palette)
export const PlusCircleOutlined = make(CirclePlus)
export const SettingOutlined = make(Settings)
export const ThunderboltOutlined = make(Zap)
export const InfoCircleOutlined = make(Info)
export const UpCircleOutlined = make(CircleArrowUp)
export const AimOutlined = make(Crosshair)
export const MenuFoldOutlined = make(PanelLeftClose)
export const ArrowsAltOutlined = make(Maximize2)
export const ShrinkOutlined = make(Minimize2)
export const PushpinOutlined = make(Pin)
export const PushpinFilled = make(Pin, { filled: true })
export const SelectOutlined = make(SquareArrowOutUpRight)
export const PlayCircleOutlined = make(CirclePlay)
export const PauseCircleOutlined = make(CirclePause)
export const UnorderedListOutlined = make(List)
export const BarChartOutlined = make(ChartColumn)
export const TranslationOutlined = make(Languages)
export const DoubleRightOutlined = make(ChevronsRight)
export const FunctionOutlined = make(SquareFunction)
export const HistoryOutlined = make(History)
export const DeleteOutlined = make(Trash2)
export const CopyOutlined = make(Copy)
export const MoreOutlined = make(Ellipsis)
export const PlusOutlined = make(Plus)
export const CodeOutlined = make(Code)
export const VerticalLeftOutlined = make(ArrowLeftToLine)
export const VerticalAlignBottomOutlined = make(ArrowDownToLine)
export const VerticalAlignTopOutlined = make(ArrowUpToLine)
export const CodeFilled = make(SquareTerminal)
export const RightSquareFilled = make(SquareChevronRight)
export const RobotOutlined = make(Bot)
export const DownOutlined = make(ChevronDown)
export const LeftOutlined = make(ChevronLeft)
export const RightOutlined = make(ChevronRight)
export const LayoutOutlined = make(PanelsTopLeft)
export const BorderlessTableOutlined = make(Grid2x2)
export const BorderOutlined = make(Square)
export const LoadingOutlined = make(Loader, { spin: true })
export const Loading3QuartersOutlined = make(LoaderCircle, { spin: true })
export const MinusOutlined = make(Minus)
export const ArrowRightOutlined = make(ArrowRight)
export const ArrowLeftOutlined = make(ArrowLeft)
export const ArrowDownOutlined = make(ArrowDown)
export const ArrowUpOutlined = make(ArrowUp)
export const SunOutlined = make(Sun)
export const MoonOutlined = make(Moon)
export const CheckCircleOutlined = make(CircleCheck)
export const CloseCircleOutlined = make(CircleX)
export const WarningOutlined = make(TriangleAlert)
export const ImportOutlined = make(Import)
export const ExportOutlined = make(Upload)
export const SaveOutlined = make(Save)
export const ClearOutlined = make(Eraser)
export const ReloadOutlined = make(RotateCw)
export const DiffOutlined = make(Diff)
export const MinusSquareOutlined = make(SquareMinus)
export const SwapOutlined = make(ArrowLeftRight)
export const SearchOutlined = make(Search)
export const ClockCircleOutlined = make(Clock)
export const MinusCircleOutlined = make(CircleMinus)
export const LockOutlined = make(Lock)
export const EditOutlined = make(SquarePen)
export const CloseOutlined = make(X)
export const FrownOutlined = make(Frown)
