-- Partner-Hunter (Howard) data layer. All tables namespaced ph_*.
-- Accessed exclusively via the service-role key from the Vercel worker;
-- RLS is enabled with no policies so anon/authenticated roles see nothing.

create table ph_partners (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  segment text not null check (segment in ('memorial','vet')),
  subtype text,
  city text,
  state text,
  website text,
  email text,
  email_status text not null default 'unverified' check (email_status in ('verified','risky','invalid','unverified')),
  phone text,
  contact_name text,
  source text not null,
  sells_memorial_products boolean,
  offers_aftercare boolean,
  reviews_count integer,
  rating numeric,
  is_chain boolean not null default false,
  fit_score numeric,
  stage text not null default 'sourced' check (stage in ('sourced','qualified','queued','contacted','replied','negotiating','signed','live','declined')),
  assigned_offer text,
  sample_status text not null default 'none' check (sample_status in ('none','offered','requested','shipped','delivered')),
  sample_shipped_at timestamptz,
  sample_address text,
  notes text,
  enrichment jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ph_partners_website_uniq on ph_partners (lower(website)) where website is not null;
create index ph_partners_stage_idx on ph_partners (stage);
create index ph_partners_email_idx on ph_partners (lower(email));

create table ph_outreach (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references ph_partners(id) on delete cascade,
  touch_number integer not null default 1,
  subject text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft','approved','sent','replied','bounced','rejected')),
  is_reply_draft boolean not null default false,
  agentmail_thread_id text,
  agentmail_message_id text,
  sent_at timestamptz,
  replied_at timestamptz,
  reply_snippet text,
  needs_attention boolean not null default false,
  attention_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ph_outreach_status_idx on ph_outreach (status);
create index ph_outreach_partner_idx on ph_outreach (partner_id);
create index ph_outreach_thread_idx on ph_outreach (agentmail_thread_id);

create table ph_referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references ph_partners(id) on delete cascade,
  discount_code text not null unique,
  shopify_discount_gid text,
  tracking_url text,
  signed_at timestamptz not null default now(),
  orders_count integer not null default 0,
  revenue numeric not null default 0,
  last_synced_at timestamptz
);

create table ph_suppression (
  id uuid primary key default gen_random_uuid(),
  email text,
  domain text,
  reason text not null,
  created_at timestamptz not null default now()
);

create unique index ph_suppression_email_uniq on ph_suppression (lower(email)) where email is not null;
create index ph_suppression_domain_idx on ph_suppression (lower(domain));

-- Offer terms. Empty until Gideon populates it; while a key is absent the
-- drafting guardrail forbids concrete numbers and speaks in structure only.
create table ph_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Daily send accounting for cap enforcement + Health view.
create table ph_send_log (
  id uuid primary key default gen_random_uuid(),
  outreach_id uuid references ph_outreach(id) on delete set null,
  email text not null,
  dry_run boolean not null default false,
  sent_at timestamptz not null default now()
);

create index ph_send_log_sent_at_idx on ph_send_log (sent_at);

alter table ph_partners enable row level security;
alter table ph_outreach enable row level security;
alter table ph_referrals enable row level security;
alter table ph_suppression enable row level security;
alter table ph_config enable row level security;
alter table ph_send_log enable row level security;
