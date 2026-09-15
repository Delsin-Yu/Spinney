/**
 * `ClientRegistry` — the one place that turns a **model card** into an actual
 * request.
 *
 * Before model cards there was a single shared `DeepSeekClient` and one base URL /
 * API key pair for the whole window, handed to every session and every agent. Now a
 * card names its provider, so this registry owns:
 *
 *   - one `DeepSeekClient` per provider (created lazily, re-pointed when the
 *     provider's `baseUrl` is edited),
 *   - the API key per provider (read through {@link ClientRegistryHost.apiKeyFor},
 *     i.e. SecretStorage), cached until it changes,
 *   - the two concurrency gates: one per provider, one per card
 *     ({@link RequestGate}),
 *   - the routing itself: `stream(card, request)` fills in `body.model` from the
 *     card's `oaiModel`, so no caller can send a request naming a model the card
 *     did not declare.
 *
 * What takes a slot: chat completions and file uploads. What does not: the
 * session-title request and the wallet readout — they are bookkeeping, and letting
 * a batch auto-naming run occupy every slot would starve the conversation.
 */

import { CompletionRequest, DeepSeekBalance, DeepSeekClient } from './deepseek';
import { ModelCard, ProviderSpec, cards, providerById, providerSpecs } from './models';
import { RequestGate, GateStats } from './requestGate';
import { StreamChunk, UploadedFile, Usage } from './types';

/** What the registry needs from the host: the key of a provider, and nothing else. */
export interface ClientRegistryHost {
  /** The API key for a provider id (SecretStorage, then the environment), or ''. */
  apiKeyFor(providerId: string): Promise<string>;
}

/** Reported once, when a request could not start because every slot was taken. */
export interface QueueInfo {
  /** How many requests are ahead in the queue (including this one). */
  queued: number;
  /** The cap that is in force (never 0 here — an unlimited gate never queues). */
  limit: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, DeepSeekClient>();
  private readonly keys = new Map<string, string>();
  private readonly providerGates = new Map<string, RequestGate>();
  private readonly cardGates = new Map<string, RequestGate>();

  constructor(private readonly host: ClientRegistryHost) {}

  /**
   * Re-read the provider table: point every existing client at its (possibly
   * edited) `baseUrl` and install the current concurrency limits. Called on
   * activation and on every settings change, so an edit needs no reload and is
   * safe mid-turn (the next request reads it).
   */
  applyCatalog(): void {
    for (const provider of providerSpecs()) {
      this.clients.get(provider.id)?.configure({ baseUrl: provider.baseUrl });
      this.gateFor(provider.id, provider.concurrency);
    }
    for (const card of cards()) {
      this.cardGateFor(card.id, card.concurrency);
    }
  }

  /** Forget the cached keys; the next request (or `hasKey`) re-reads them. */
  invalidateKeys(): void {
    this.keys.clear();
  }

  /** The provider's key, cached. Empty string means "not configured". */
  async keyFor(providerId: string): Promise<string> {
    const cached = this.keys.get(providerId);
    if (cached !== undefined) {
      return cached;
    }
    let key = '';
    try {
      key = (await this.host.apiKeyFor(providerId)) || '';
    } catch {
      key = '';
    }
    this.keys.set(providerId, key);
    return key;
  }

  /** True when a key is configured for the provider (drives the page's badge). */
  async hasKey(providerId: string): Promise<boolean> {
    return (await this.keyFor(providerId)).length > 0;
  }

  /**
   * Stream one chat completion for a card. The provider's `baseUrl` and the
   * card's `oaiModel` win over whatever the caller put in the request, and the
   * slot is held until the stream ends — including when the caller breaks out or
   * the signal aborts.
   */
  async *stream(card: ModelCard, request: CompletionRequest, onQueue?: (info: QueueInfo) => void): AsyncGenerator<StreamChunk> {
    const release = await this.acquire(card, request.signal, onQueue);
    try {
      const client = await this.clientFor(card.providerId);
      yield* client.stream({ ...request, model: card.oaiModel });
    } finally {
      release();
    }
  }

  /**
   * A non-streaming completion for a card (session titles). Deliberately **not**
   * gated: it is bookkeeping, and it must never occupy a conversation's slot.
   */
  async complete(card: ModelCard, request: CompletionRequest): Promise<{ text: string; usage?: Usage }> {
    const client = await this.clientFor(card.providerId);
    return client.complete({ ...request, model: card.oaiModel });
  }

  /** Upload one image for a card's provider; takes a slot like a chat request. */
  async upload(card: ModelCard, bytes: Buffer, filename: string, signal?: AbortSignal): Promise<UploadedFile> {
    const release = await this.acquire(card, signal);
    try {
      const client = await this.clientFor(card.providerId);
      return await client.uploadFile(bytes, filename, signal);
    } finally {
      release();
    }
  }

  /** The wallet readout of a provider (ungated, account-level). */
  async balance(providerId: string): Promise<DeepSeekBalance> {
    const client = await this.clientFor(providerId);
    return client.getBalance();
  }

  /** The provider's client, with its key and `baseUrl` installed. */
  async clientFor(providerId: string): Promise<DeepSeekClient> {
    const provider: ProviderSpec = providerById(providerId);
    const key = await this.keyFor(provider.id);
    let client = this.clients.get(provider.id);
    if (!client) {
      client = new DeepSeekClient({ apiKey: key, baseUrl: provider.baseUrl, model: '' });
      this.clients.set(provider.id, client);
    } else {
      client.configure({ apiKey: key, baseUrl: provider.baseUrl });
    }
    return client;
  }

  /**
   * Take both slots (provider first, then card) and return the release. Ordering
   * is fixed so two requests can never take them in opposite orders and deadlock.
   */
  private async acquire(card: ModelCard, signal?: AbortSignal, onQueue?: (info: QueueInfo) => void): Promise<() => void> {
    const providerGate = this.gateFor(card.providerId, providerById(card.providerId).concurrency);
    const cardGate = this.cardGateFor(card.id, card.concurrency);
    const report = (queued: number, limit: number) => onQueue?.({ queued, limit });
    await providerGate.acquire(signal, () => {
      const stats = providerGate.stats;
      report(stats.queued, stats.limit);
    });
    try {
      await cardGate.acquire(signal, () => {
        const stats = cardGate.stats;
        report(stats.queued, stats.limit);
      });
    } catch (err) {
      providerGate.release();
      throw err;
    }
    return () => {
      cardGate.release();
      providerGate.release();
    };
  }

  private gateFor(providerId: string, limit: number): RequestGate {
    let gate = this.providerGates.get(providerId);
    if (!gate) {
      gate = new RequestGate(limit);
      this.providerGates.set(providerId, gate);
    } else {
      gate.setLimit(limit);
    }
    return gate;
  }

  private cardGateFor(cardId: string, limit: number): RequestGate {
    let gate = this.cardGates.get(cardId);
    if (!gate) {
      gate = new RequestGate(limit);
      this.cardGates.set(cardId, gate);
    } else {
      gate.setLimit(limit);
    }
    return gate;
  }
}
