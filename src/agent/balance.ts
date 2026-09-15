/**
 * The wallet readout — the one place that knows how a provider reports its
 * remaining credit, and the shape the chat webview is told about.
 *
 * There is no standard endpoint for this. DeepSeek answers `GET /user/balance`,
 * OpenRouter `GET /credits`, Moonshot `GET /users/me/balance`, and an
 * OpenAI-compatible endpoint (or a local vLLM / llama.cpp) usually has no wallet
 * at all. So the dialect is a **declaration on the provider node**
 * (`ProviderSpec.balance`) — the same shape of decision as a card's image
 * transport: the user is the one who knows which endpoint they pointed at, and
 * nothing here probes for it. `none` is a first-class answer, not a failure.
 *
 * Every dialect is normalized into one `Balance` of `BalanceEntry` per currency, so
 * the webview has a single thing to render and a new dialect is one parser here plus
 * one option in the Model Card Tree page's select. The optional fields are what the
 * vendor actually reports and nothing else: DeepSeek splits the remainder into
 * granted + topped-up, OpenRouter reports what has been spent, Moonshot splits it
 * into a voucher and cash. A dialect that reports neither leaves both out, and the
 * UI's detail line then says nothing instead of inventing a zero — which is also why
 * a payload that is missing an amount its dialect needs (the total, or the list it
 * lives in) **throws** rather than rendering `0.00`: the wrong dialect on a row must
 * look like "no wallet line" plus one line in the output channel, never like an empty
 * account. Only the *detail* fields are optional, because a dialect that reports no
 * split really has no split to show.
 *
 * The readout is deliberately **not retried** (see `invariants/api-retries.md`): it
 * is bookkeeping, so one failure is one line in the output channel, and the caller
 * shows an empty readout rather than a stale number from another provider.
 */

import { ApiError } from './apiClient';

/**
 * How a provider's wallet is read. Named after the vendor whose dialect it is —
 * that is what the user picks between — plus `none` for "this endpoint has no
 * wallet line" (a local server, a gateway, or a vendor nobody has written a parser
 * for yet).
 */
export type BalanceDialect = 'none' | 'deepseek' | 'openrouter' | 'moonshot';

/** The dialects in the order the Model Card Tree page offers them. */
export const BALANCE_DIALECTS: readonly BalanceDialect[] = ['none', 'deepseek', 'openrouter', 'moonshot'];

/** True when the value is one of the dialects — the settings parser and the page share this list. */
export function isBalanceDialect(value: unknown): value is BalanceDialect {
  return typeof value === 'string' && (BALANCE_DIALECTS as readonly string[]).includes(value);
}

/** One currency's wallet line, normalized across dialects. */
export interface BalanceEntry {
  /** The currency the amounts are in, as the provider spells it (`CNY`, `USD`). */
  currency: string;
  /** What is left to spend. */
  total: number;
  /** The part of `total` that is credit rather than money (DeepSeek, Moonshot). */
  granted?: number;
  /** The part of `total` that was paid for (DeepSeek, Moonshot). */
  toppedUp?: number;
  /** What has been spent already (OpenRouter). */
  used?: number;
}

/** A provider's whole readout: one entry per currency it reports. */
export interface Balance {
  /** The provider's own statement that the account may spend; `false` is its answer, not a failure. */
  isAvailable: boolean;
  balances: BalanceEntry[];
}

/**
 * Nothing to show. What a `none` provider answers with, and what a caller posts
 * after a failed refresh — the UI clears on it, so a tab can never keep another
 * provider's number on screen.
 */
export function emptyBalance(): Balance {
  return { isAvailable: true, balances: [] };
}

/** One readout to fetch: the provider's dialect, its endpoint, its key and its name. */
export interface BalanceRequest {
  dialect: BalanceDialect;
  baseUrl: string;
  apiKey: string;
  /** The provider's display name — named in the errors this throws, so the log line says whose wallet failed. */
  providerName: string;
  /** The caller's cancellation, when it has one. */
  signal?: AbortSignal;
}

/**
 * Fetch one provider's wallet in its own dialect. `none` answers with the empty
 * readout and sends no request at all. Throws `ApiError` on a missing key, a network
 * failure, a non-OK status, or a payload that is not the shape the dialect expects.
 */
export async function fetchBalance(request: BalanceRequest): Promise<Balance> {
  if (request.dialect === 'none') {
    return emptyBalance();
  }
  if (!request.apiKey) {
    throw new ApiError(
      `No API key configured for ${request.providerName}. Run the spinney.setApiKey command (or set the DEEPSEEK_API_KEY environment variable for the built-in provider).`,
    );
  }
  const dialect = DIALECTS[request.dialect];
  const url = `${request.baseUrl.replace(/\/$/, '')}${dialect.path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${request.apiKey}` },
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal?.aborted) {
      throw new ApiError('Balance request aborted.');
    }
    throw new ApiError(`Network error fetching the balance: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(`Balance error ${response.status}: ${text || response.statusText}`, response.status);
  }
  const data = (await response.json().catch(() => undefined)) as unknown;
  return dialect.parse(data);
}

/** A number a provider sent, which may be a string (DeepSeek sends `"12.34"`). */
function number(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A field the dialect cannot work without; a payload without it is a wrong dialect, not a zero. */
function required(value: number | undefined, what: string): number {
  if (value === undefined) {
    throw new ApiError(`The balance response has no ${what}.`);
  }
  return value;
}

/** One row of a payload, as a bag of unknown fields. */
function fields(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * The parsers. Each one turns its vendor's payload into the normalized shape, and
 * each one is the **only** place that knows that vendor's field names — the settings,
 * the page and the webview carry the dialect name and never a field name.
 */
const DIALECTS: Record<
  Exclude<BalanceDialect, 'none'>,
  { path: string; parse(data: unknown): Balance }
> = {
  /** `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` */
  deepseek: {
    path: '/user/balance',
    parse(data: unknown): Balance {
      const body = fields(data);
      const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
      if (infos.length === 0) {
        throw new ApiError('The balance response is missing balance_infos.');
      }
      return {
        isAvailable: !!body.is_available,
        balances: infos.map((raw) => {
          const info = fields(raw);
          return {
            currency: typeof info.currency === 'string' && info.currency.trim() ? info.currency.trim() : 'CNY',
            total: required(number(info.total_balance), 'total_balance'),
            granted: number(info.granted_balance),
            toppedUp: number(info.topped_up_balance),
          };
        }),
      };
    },
  },

  /** `{ data: { total_credits, total_usage } }` — the remainder is the difference, and `used` is the spend. */
  openrouter: {
    path: '/credits',
    parse(data: unknown): Balance {
      const info = fields(fields(data).data);
      const credits = required(number(info.total_credits), 'total_credits');
      const used = required(number(info.total_usage), 'total_usage');
      return { isAvailable: true, balances: [{ currency: 'USD', total: credits - used, used }] };
    },
  },

  /** `{ data: { available_balance, voucher_balance, cash_balance } }` — the voucher/cash split maps onto granted/topped-up. */
  moonshot: {
    path: '/users/me/balance',
    parse(data: unknown): Balance {
      const info = fields(fields(data).data);
      const total = required(number(info.available_balance), 'available_balance');
      return {
        isAvailable: true,
        balances: [
          {
            currency: 'CNY',
            total,
            granted: number(info.voucher_balance),
            toppedUp: number(info.cash_balance),
          },
        ],
      };
    },
  },
};
