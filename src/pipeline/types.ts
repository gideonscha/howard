export interface Partner {
  id: string;
  business_name: string;
  segment: "memorial" | "vet";
  subtype: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  email: string | null;
  email_status: "verified" | "catch_all" | "risky" | "invalid" | "unverified";
  phone: string | null;
  contact_name: string | null;
  source: string;
  sells_memorial_products: boolean | null;
  offers_aftercare: boolean | null;
  reviews_count: number | null;
  rating: number | null;
  is_chain: boolean;
  fit_score: number | null;
  stage:
    | "sourced"
    | "qualified"
    | "queued"
    | "contacted"
    | "replied"
    | "negotiating"
    | "signed"
    | "live"
    | "declined";
  assigned_offer: string | null;
  sample_status: "none" | "offered" | "requested" | "shipped" | "delivered";
  sample_shipped_at: string | null;
  sample_address: string | null;
  notes: string | null;
  enrichment: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Outreach {
  id: string;
  partner_id: string;
  touch_number: number;
  subject: string;
  body: string;
  status: "draft" | "approved" | "sent" | "replied" | "bounced" | "rejected";
  is_reply_draft: boolean;
  agentmail_thread_id: string | null;
  agentmail_message_id: string | null;
  sent_at: string | null;
  replied_at: string | null;
  reply_snippet: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  created_at: string;
}
