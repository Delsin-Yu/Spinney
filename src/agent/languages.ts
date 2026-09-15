import { CANONICAL_TAGS } from '../languageTags';
import { DEFAULT_REPLY_LANGUAGE } from './prompt';

/**
 * Translation of the reply-language setting (`spinney.replyLanguage`) into the
 * language the prompt asks for.
 *
 * The stored value is either `auto` (follow the VS Code display language) or one
 * of the language tags the setting's `enum` offers in `package.json` — the
 * languages VS Code itself ships display translations for. What reaches the
 * prompt is always a language **name** ("Japanese", "Simplified Chinese"): a name
 * is what a model acts on, and it stays readable in the transcript.
 *
 * The names come from `Intl.DisplayNames` (CLDR data, offline), so the tag list
 * lives in exactly one place — the setting's `enum` — and nothing here has to be
 * kept in step with it. The `enumDescriptions` next to that `enum` are these same
 * names verbatim, so the dropdown in Settings reads exactly like the prompt does.
 */
export const AUTO_REPLY_LANGUAGE = 'auto';

/**
 * A plausible BCP-47 language tag ("ja", "zh-cn", "zh-Hans"). A free-form name
 * ("Japanese", "Norwegian Bokmål") deliberately does not match — that is how the
 * two cases are told apart, so a hand-written name is never mangled by CLDR.
 */
const TAG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * The language name for the prompt, given the setting's value and the VS Code
 * display language (`vscode.env.language`; passed in so this stays pure, exactly
 * like the prompt builders' environment facts).
 *
 *  - `auto` (the default), blank, or a blank locale → follow `vscodeLocale`;
 *  - a language tag → its CLDR name ("ja" → "Japanese", "zh-cn" → "Simplified Chinese");
 *  - anything else → used verbatim, so a language VS Code has no pack for
 *    ("Norwegian Bokmål") still works from `settings.json`.
 *
 * `DEFAULT_REPLY_LANGUAGE` is the floor: a value that resolves to nothing at all
 * must never send an empty `## Language` line to the model.
 */
export function replyLanguageName(value: string, vscodeLocale: string): string {
  const raw = (value || '').trim();
  const locale = (vscodeLocale || '').trim();
  const candidate = !raw || raw.toLowerCase() === AUTO_REPLY_LANGUAGE ? locale : raw;
  if (!candidate) {
    return DEFAULT_REPLY_LANGUAGE;
  }
  if (!TAG_PATTERN.test(candidate)) {
    return candidate; // a free-form language name: used as written
  }
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    // `zh-cn` / `zh-tw` still arrive (what `vscode.env.language` reports, and what
    // an older `settings.json` holds); `CANONICAL_TAGS` is the one place that knows
    // they mean `zh-Hans` / `zh-Hant`. See `src/languageTags.ts`.
    return names.of(CANONICAL_TAGS[candidate.toLowerCase()] ?? candidate) || candidate;
  } catch {
    return candidate; // not a tag this runtime can name
  }
}
