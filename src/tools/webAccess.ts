import type { ModelCard, SearchProvider } from '../agent/models';

/**
 * The two web tools' one piece of live context: **which engine leads, and with what
 * token**.
 *
 * Why this is an injection and not a setting read: a tool has no `ExtensionContext`
 * and no session, and the answer belongs to the **model card of the node whose turn
 * is running** (`cardForNode`) — the same per-node identity that decides the model,
 * the level and whether images are sent. The card declares the provider
 * (`searchProvider`), the provider supplies the endpoint (`baseUrl`), and the token
 * comes out of `SecretStorage` — three things only the host knows. So the host
 * installs one resolver at activation (`ChatViewProvider`), the registry hands in the
 * card (`ToolRegistry.setWebCard`), and nothing below this line knows what a
 * provider or a secret is.
 *
 * The resolver takes `undefined` for "no node card in force" (the
 * `Spinney: Test Web Search Backends` command has no turn): the host answers that one
 * with the **vendored** card, which is the shipped `deepseek`/`built-in` pair — the
 * measurement the command exists to make.
 */
export interface SearchAccess {
  /** `builtin` = the keyless chain only; `deepseek` = the provider's API leads. */
  provider: SearchProvider;
  /** The API root of the card's provider, without a trailing slash; '' when unknown. */
  baseUrl: string;
  /** The bearer token for that root; '' when nothing is configured. */
  token: string;
}

/** The card of the node whose turn is running; `undefined` when there is none. */
export type CardResolver = () => ModelCard | undefined;

/** Resolve the live access for a card (`undefined` = no node in force). */
export type SearchAccessResolver = (card: ModelCard | undefined) => Promise<SearchAccess>;

/** What a host that never installed a resolver gets: today's keyless behaviour. */
export const BUILTIN_ONLY: SearchAccess = { provider: 'builtin', baseUrl: '', token: '' };

let resolveAccess: SearchAccessResolver | null = null;

/** Install the host's resolver. One per extension host; the Model Card page edits what it reads. */
export function setSearchAccessResolver(resolver: SearchAccessResolver | null): void {
  resolveAccess = resolver;
}

/**
 * The access in force for this call. A resolver that throws (a locked keyring, a
 * broken settings row) is answered with the keyless default: the tools must keep
 * working when the paid tier cannot be resolved.
 */
export async function searchAccessFor(card: ModelCard | undefined): Promise<SearchAccess> {
  if (!resolveAccess) {
    return BUILTIN_ONLY;
  }
  try {
    return await resolveAccess(card);
  } catch {
    return BUILTIN_ONLY;
  }
}

/**
 * The account-wide query rate of the provider's web APIs — 5 requests per second,
 * **Search and Fetch limited independently** — is a property of the account, not of
 * a card, so the gate is process-wide and one per endpoint kind.
 *
 * A burst is what makes this necessary rather than polite: parallel nodes and
 * sub-agents all reach `web_search` at once, the provider answers 429 for the surplus,
 * and the surplus would otherwise open a cooldown on the backend the rest of the turn
 * needs. Spacing the starts keeps the 429 for a genuinely over-quota account.
 */
const RATE_GAP_MS = 220;
const rateChains = new Map<string, Promise<void>>();

/** Wait for this endpoint kind's next 220 ms slot. Never rejects. */
export function awaitApiSlot(kind: 'search' | 'fetch'): Promise<void> {
  const previous = rateChains.get(kind) ?? Promise.resolve();
  const next = previous.then(() => new Promise<void>((resolve) => setTimeout(resolve, RATE_GAP_MS)));
  rateChains.set(kind, next);
  return next;
}
