import type { ChatRecipe } from '@vozella/core';
import { BookOpenText, MessageSquareText, Pencil } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Icon, IconButton, Tooltip, cn } from '../../ui';

export interface StarterListProps {
  /** The small heading that names the list: what the starters ask about. */
  readonly heading: string;
  readonly recipes: readonly ChatRecipe[];
  /** Sends the recipe's prompt at once (with a saved prompt's engine). */
  readonly onPick: (recipe: ChatRecipe) => void;
  /** Opens the prompt editor for a saved prompt. */
  readonly onEdit: (recipe: ChatRecipe) => void;
}

/**
 * Up to four suggested questions for an empty chat, one full-width row each; saved prompts lead.
 * A click on a row sends at once. A saved prompt's row also has a pencil, shown on hover and
 * keyboard focus and always in the tab order after its row, that opens the prompt editor.
 */
export function StarterList({ heading, recipes, onPick, onEdit }: StarterListProps) {
  const t = useT();
  const headingId = useId();
  if (recipes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p
        id={headingId}
        className="px-2 text-ui font-medium text-ink-muted forced-colors:text-inherit"
      >
        {heading}
      </p>
      <ul
        data-testid="ListMeetingChatStarters"
        aria-labelledby={headingId}
        className="flex flex-col"
      >
        {recipes.map((recipe) => {
          const mine = recipe.owner === 'user';
          return (
            <li key={recipe.id} className="group/starter relative">
              <Tooltip content={recipe.prompt} side="left">
                <button
                  type="button"
                  data-testid="BtnChatStarter"
                  data-owner={recipe.owner}
                  onClick={() => {
                    onPick(recipe);
                  }}
                  className={cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-start text-ui-lg text-ink',
                    'transition-colors duration-150 ease-out-quick motion-reduce:transition-none',
                    'group-hover/starter:bg-hover active:bg-pressed',
                    mine && 'pe-9',
                  )}
                >
                  <Icon
                    icon={mine ? BookOpenText : MessageSquareText}
                    className="text-ink-muted forced-colors:text-inherit"
                  />
                  <span className="min-w-0 truncate">{recipe.name}</span>
                </button>
              </Tooltip>
              {mine ? (
                <span
                  className={cn(
                    'absolute inset-y-0 end-1 flex items-center opacity-0',
                    'transition-opacity duration-150 ease-out-quick motion-reduce:transition-none',
                    'group-focus-within/starter:opacity-100 group-hover/starter:opacity-100',
                  )}
                >
                  <IconButton
                    label={t('Ui_ChatPromptEdit', recipe.name)}
                    icon={Pencil}
                    size="sm"
                    data-testid="BtnChatStarterEdit"
                    onClick={() => {
                      onEdit(recipe);
                    }}
                    className="size-6 text-ink-muted"
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
