'use client';

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  run: () => void;
};
export type PaletteTarget = {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
};

/** Matches shown for steps and outputs; typing more narrows large workspaces. */
const TARGET_LIMIT = 40;

/** Ctrl+K: run a command, or find and open any step or output by name. */
export default function WorkflowCommandPalette({
  open,
  onOpenChange,
  commands,
  targets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  /** Built on demand: a workspace can hold thousands of steps and outputs. */
  targets: () => PaletteTarget[];
}) {
  const [query, setQuery] = useState('');
  // Every typed word must appear, in any order.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => {
    const lower = text.toLowerCase();
    return words.every((word) => lower.includes(word));
  };
  const shownCommands = commands.filter((command) => matches(command.label));
  // Only while searching: listing every step and output is linear in the
  // workspace, so results stop at TARGET_LIMIT.
  const found = { items: [] as PaletteTarget[], more: false };
  if (open && words.length)
    for (const target of targets()) {
      if (!matches(`${target.label} ${target.hint}`)) continue;
      if (found.items.length === TARGET_LIMIT) {
        found.more = true;
        break;
      }
      found.items.push(target);
    }
  function close(next: boolean) {
    onOpenChange(next);
    if (!next) setQuery('');
  }
  function run(action: () => void) {
    close(false);
    action();
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={close}
      title="Search or run a command"
      description="Find a step or output by name, or run a command."
      className="workflow-palette"
    >
      <Command shouldFilter={false} loop>
        <CommandInput
          aria-label="Search steps, outputs and commands"
          placeholder="Search steps, outputs and commands…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matching steps, outputs or commands.</CommandEmpty>
          {shownCommands.length > 0 && (
            <CommandGroup heading="Commands">
              {shownCommands.map(
                ({
                  id,
                  label,
                  hint,
                  shortcut,
                  icon: Icon,
                  disabled,
                  run: action,
                }) => (
                  <CommandItem
                    key={id}
                    value={id}
                    disabled={disabled}
                    onSelect={() => run(action)}
                  >
                    <Icon />
                    <span className="workflow-palette-label">{label}</span>
                    {hint && <small>{hint}</small>}
                    {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          )}
          {found.items.length > 0 && (
            <CommandGroup heading="Steps and outputs">
              {found.items.map(
                ({ id, label, hint, icon: Icon, run: action }) => (
                  <CommandItem key={id} value={id} onSelect={() => run(action)}>
                    <Icon />
                    <span className="workflow-palette-label">{label}</span>
                    <small>{hint}</small>
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          )}
          {found.more && (
            <p className="workflow-palette-more">
              Showing the first {TARGET_LIMIT} matches. Type more to narrow
              them.
            </p>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
