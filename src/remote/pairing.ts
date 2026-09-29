/**
 * pairing.ts — the room pairing payload: the one string a phone reads out of a QR code.
 *
 * WHY THE TOKEN TRAVELS DEVICE TO DEVICE. A token is the only trust root remote control has
 * and it *is* the room: two devices meet because their tokens match, and the room id in the
 * relay URL path is a one-way function of the token (`remote/PROTOCOL.md` §3). The relay
 * therefore never learns the token and can never hand it to a second device, so the only
 * channel left between the two devices is the one in front of the user: the desktop, which
 * holds the token, shows it, and the phone reads it out of a photo with the system picker it
 * already has. This module is the *codec* for that one string and nothing else — it imports
 * no `vscode`, opens no socket, and is driven from plain node by `tools/check-remote.js`.
 *
 * THE FORMAT.
 *
 *     spinney-pair:1?relay=<r>&room=<n>&token=<t>
 *
 * The prefix, then a **version integer**, then `?` and exactly three parameters in the order
 * relay, room, token. `relay` is the relay base URL, `room` the room's **local label**
 * (`roomsStore.ts`: it never travels over the wire — it travels here, so the phone can name
 * the room the way its user does), and `token` the raw token. The values are percent-encoded
 * per **RFC 3986** over their UTF-8 bytes: a space is `%20` and a literal `+` is `%2B`.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. A literal `+` in a query value is a *web form*
 * convention, not RFC 3986: Java's `URLEncoder` writes a space as `+` and its `URLDecoder`
 * reads `+` back as a space, while JS's `encodeURIComponent`/`decodeURIComponent` write a
 * space as `%20` and treat `+` literally. Pick the wrong pair and a token containing `+`
 * arrives at the phone with a space in it — which is a *different room*, and an empty one,
 * which until now looked exactly like an idle one. So no bare `+` (and no space) may ever be
 * emitted, which is what the strict `%XX` encoding below guarantees; the Android side is
 * told to write the matching strict `%XX` decoder rather than a form decoder.
 *
 * THE PHONE'S PARSER IS STRICT, AND THAT IS A FEATURE. It refuses an unknown prefix or
 * version, a missing or empty parameter, and **any parameter it does not know** — unknown
 * fields cannot be ignored, because a version-1 parser that skipped them would silently
 * mis-read a version-2 payload. That is why this module refuses to emit anything but the
 * three named parameters, and why a fourth field means bumping the version prefix.
 */

/** The scheme prefix, before the version integer. Part of the wire contract. */
export const PAIRING_PREFIX = 'spinney-pair';
/** The payload version this build writes. A new parameter bumps it (the parser ignores none). */
export const PAIRING_VERSION = 1;

/** The three parameters, in the order they are emitted. */
export const PAIRING_PARAMS = ['relay', 'room', 'token'] as const;

/** What one payload carries: the relay address, the room's local label and the raw token. */
export interface PairingInput {
  /** The relay base URL, exactly as the room row carries it (this module never normalizes it). */
  readonly relayUrl: string;
  /** The room's local label — a name for the phone's user, not a routing fact. */
  readonly roomName: string;
  /** The room token itself. The one secret this payload carries. */
  readonly token: string;
}

/**
 * `encodeURIComponent` leaves these five alone, and RFC 3986 does **not** call them
 * unreserved (`-._~` and the alphanumerics are the unreserved set; these are sub-delims that
 * are merely *allowed* in a query). Escaping them costs nothing and makes the payload
 * stricter than a decoder needs: every character outside `A-Za-z0-9-._~` leaves as `%XX`,
 * which is the one shape both ends are told to expect.
 */
const SUB_DELIMS_LEFT_BARE = /[!'()*]/g;

/**
 * One value as RFC 3986 percent-encoded bytes. `encodeURIComponent` is already the correct
 * UTF-8 `%XX` encoder — the whole point of the trap above — and is only tightened here (see
 * {@link SUB_DELIMS_LEFT_BARE}).
 *
 * A lone UTF-16 surrogate is refused rather than encoded: it has no UTF-8 bytes, the phone
 * would read U+FFFD where the desktop had a half-character, and a token that decodes to a
 * different string is a different room. That is the failure this payload exists to prevent, so
 * it is better to refuse the pairing than to emit it.
 */
function encodeValue(value: string, field: string): string {
  try {
    return encodeURIComponent(value).replace(SUB_DELIMS_LEFT_BARE, (ch) => {
      return `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
    });
  } catch {
    throw new Error(`pairing: ${field} contains an unpaired UTF-16 surrogate, which has no UTF-8 encoding`);
  }
}

/**
 * The pairing payload for one room.
 *
 * Throws rather than emitting something the phone's strict parser would refuse (or, worse,
 * accept as a different room): an empty relay/room/token is rejected here because the parser
 * rejects an empty parameter, and a value with an unpaired surrogate because it cannot be
 * represented as UTF-8 at all. Nothing else is emitted — no extra parameter, no room id, no
 * version negotiation — because the parser refuses any parameter it does not know.
 */
export function buildPairingPayload(input: PairingInput): string {
  const fields: readonly [string, unknown][] = [
    ['relay', input?.relayUrl],
    ['room', input?.roomName],
    ['token', input?.token],
  ];
  const encoded: string[] = [];
  for (const [field, value] of fields) {
    if (typeof value !== 'string') {
      throw new Error(`pairing: ${field} must be a string`);
    }
    if (value.length === 0) {
      throw new Error(`pairing: ${field} is empty, and the phone refuses an empty parameter`);
    }
    encoded.push(`${field}=${encodeValue(value, field)}`);
  }
  return `${PAIRING_PREFIX}:${PAIRING_VERSION}?${encoded.join('&')}`;
}
