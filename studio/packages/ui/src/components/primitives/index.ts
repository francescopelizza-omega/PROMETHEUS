/**
 * components/primitives — the vendored shadcn/Radix primitive set (file 08 §3.1).
 *
 * Each is a real, accessible component (ARIA roles + keyboard ops) styled via the
 * design-system token CSS vars + a `cva()`/`cn()` class config (the Tailwind preset
 * maps those classes to the tokens once Tailwind/PostCSS are installed). The heavy
 * deps (@radix-ui/react-*, lucide-react, class-variance-authority, clsx, tailwind-
 * merge, tailwindcss/postcss/autoprefixer) are DECLARED in package.json and installed
 * by the orchestrator AFTER this pass; until then these env-discipline equivalents
 * render + are keyboard-operable today (see each file's header + cn.ts).
 *
 * The EXISTING components (Button/Panel/StatusBar/VerdictBadge/CostLight) keep their
 * own CSS-var styling and are NOT retrofitted — they are exported from the parent
 * components/ barrel via the package index.
 */

/* ── form controls ───────────────────────────────────────────────────────────── */
export { IconButton, iconButtonVariants } from "./IconButton.js";
export type { IconButtonProps, IconButtonVariant, IconButtonSize } from "./IconButton.js";
export { Input, Textarea, inputVariants, textareaVariants } from "./Input.js";
export type { InputProps, TextareaProps } from "./Input.js";
export { Checkbox, Switch, RadioGroup, RadioGroupItem } from "./Toggle.js";
export type {
  CheckboxProps,
  SwitchProps,
  RadioGroupProps,
  RadioGroupItemProps,
} from "./Toggle.js";
export { Slider } from "./Slider.js";
export type { SliderProps } from "./Slider.js";
export { Select, Combobox } from "./Select.js";
export type { SelectProps, SelectOption, ComboboxProps } from "./Select.js";

/* ── overlays / layering ─────────────────────────────────────────────────────── */
export { Dialog, AlertDialog, Sheet } from "./Dialog.js";
export type { DialogProps, AlertDialogProps, SheetProps } from "./Dialog.js";
export { Popover, Tooltip } from "./Popover.js";
export type { PopoverProps, TooltipProps } from "./Popover.js";
export { DropdownMenu, ContextMenu } from "./Menu.js";
export type { DropdownMenuProps, ContextMenuProps, MenuItem } from "./Menu.js";
export { Command } from "./Command.js";
export type { CommandProps, CommandItem } from "./Command.js";
export { ToastViewport, useToasts } from "./Toast.js";
export type { ToastViewportProps, ToastData, ToastTone } from "./Toast.js";

/* ── disclosure / navigation ─────────────────────────────────────────────────── */
export { Tabs, Accordion, nextTabIndex } from "./Tabs.js";
export type { TabsProps, TabItem, AccordionProps, AccordionItem } from "./Tabs.js";
export { Resizable, clampSplit } from "./Resizable.js";
export type { ResizableProps } from "./Resizable.js";

/* ── data display ────────────────────────────────────────────────────────────── */
export { Table } from "./Table.js";
export type { TableProps, TableColumn } from "./Table.js";
export { Tree, flattenTree } from "./Tree.js";
export type { TreeProps, TreeNode, FlatRow } from "./Tree.js";
export { Badge, Tag, badgeVariants } from "./Badge.js";
export type { BadgeProps, BadgeRole, TagProps } from "./Badge.js";

/* ── structure / feedback ────────────────────────────────────────────────────── */
export { Separator, Avatar, Skeleton, Progress, ScrollArea } from "./Layout.js";
export type {
  SeparatorProps,
  AvatarProps,
  SkeletonProps,
  ProgressProps,
  ScrollAreaProps,
} from "./Layout.js";

/* ── pure helpers (testable) ─────────────────────────────────────────────────── */
export { subsequenceScore, filterItems } from "./filter.js";

/* ── class utilities (cn / cva) ──────────────────────────────────────────────── */
export { cn, cva } from "../util/index.js";
export type { ClassValue, VariantProps } from "../util/index.js";
