export interface MailAddress {
  name?: string;
  email: string;
}

export interface MailMessage {
  emailId: string;
  threadId?: string;
  mailboxIds: string[];
  receivedAt?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  preview: string;
  textBody?: string;
  htmlBody?: string;
  hasAttachment: boolean;
}

export interface MailWriteAccepted {
  outcome: "accepted";
  messageId: string;
  submissionIds: string[];
  /** Authoritative sender identity returned by octo-mail for this write. */
  senderAddress?: string;
}

// Backward-compatible name used by the synthetic POC client. Real write
// callers should use MailWriteResult because policy may hold mail as a Draft.
export type MailReplyAccepted = MailWriteAccepted;

export interface MailPolicyReason {
  code: string;
  title: string;
  description: string;
}

export interface MailOwnerReviewRequired {
  outcome: "owner_review_required";
  status: "pending_confirmation";
  draftId: string;
  draftSubject: string;
  draftVersion: number;
  policyVersion: string;
  reasons: MailPolicyReason[];
  source: "owner_direct" | "inbound_auto_reply";
  sourceEmailId?: string;
}

export interface MailOwnerConfirmationRequired {
  outcome: "owner_confirmation_required";
  status: "pending_confirmation";
  draftType: "agent_pending_confirmation" | "agent_reply_draft";
  draftId: string;
  draftSubject: string;
  senderAddress?: string;
  draftVersion: number;
  sourceEmailId?: string;
  threadId?: string;
}

export type MailWriteResult =
  | MailWriteAccepted
  | MailOwnerReviewRequired
  | MailOwnerConfirmationRequired;

export interface MailAutoReplyStopped {
  outcome: "auto_reply_stopped";
  reason: "max_auto_replies_reached";
}

export type MailAutoReplyResult =
  | MailWriteAccepted
  | MailOwnerReviewRequired
  | MailAutoReplyStopped;

export interface MailAutoReplyContext {
  enabled: boolean;
  autoReplyCount: number;
  maxAutoReplyCount: number;
  nextReplyIsFinal: boolean;
  limitReached: boolean;
}

export interface MailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}

export interface MailClient {
  getMessage(emailId: string, signal?: AbortSignal): Promise<MailMessage>;
  reply(
    emailId: string,
    text: string,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailWriteResult>;
  replyAutomatically(
    emailId: string,
    text: string,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailAutoReplyResult>;
  send(
    input: MailSendInput,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailWriteResult>;
  confirmDraft(
    draftId: string,
    draftVersion: number,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailWriteAccepted>;
}

export interface MailIdentityClient {
  /** Return the authoritative mailbox address bound to the current credential. */
  getIdentityAddress(signal?: AbortSignal): Promise<string>;
}

export interface EmailChangesPage {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface MailDiscoveryClient {
  getMailAccountId(signal?: AbortSignal): Promise<string>;
  getInboxMailboxId(signal?: AbortSignal): Promise<string>;
  getCurrentEmailState(signal?: AbortSignal): Promise<string>;
  getEmailChanges(
    sinceState: string,
    maxChanges: number,
    signal?: AbortSignal,
  ): Promise<EmailChangesPage>;
  getMessages(
    emailIds: string[],
    signal?: AbortSignal,
  ): Promise<MailMessage[]>;
  getAutoReplyContext(
    emailId: string,
    signal?: AbortSignal,
  ): Promise<MailAutoReplyContext>;
}

export interface MailEmailStateChange {
  accountId: string;
  state: string;
}

/** Optional RFC 8620 push capability used to wake Email/changes. */
export interface MailPushDiscoveryClient {
  watchEmailStateChanges(
    onChange: (change: MailEmailStateChange) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

export function supportsMailPushDiscovery(
  client: MailDiscoveryClient,
): client is MailDiscoveryClient & MailPushDiscoveryClient {
  return (
    "watchEmailStateChanges" in client &&
    typeof client.watchEmailStateChanges === "function"
  );
}

export class MailClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly outcome: "not-sent" | "unknown";

  constructor(options: {
    code: string;
    message: string;
    status?: number;
    outcome?: "not-sent" | "unknown";
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "MailClientError";
    this.code = options.code;
    this.status = options.status;
    this.outcome = options.outcome ?? "not-sent";
  }
}
