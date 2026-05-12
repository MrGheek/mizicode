--
-- PostgreSQL database dump
--


-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10


--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS drizzle;




--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.api_keys (
    id integer NOT NULL,
    key_hash text NOT NULL,
    label text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp without time zone,
    last_used_at timestamp without time zone,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: bundle_evals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.bundle_evals (
    id integer NOT NULL,
    bundle_id integer NOT NULL,
    eval_run_count integer DEFAULT 0 NOT NULL,
    avg_composite_score real,
    avg_baseline_score real,
    avg_lift real,
    confidence_score real DEFAULT 0 NOT NULL,
    best_task_mode text,
    best_token_mode text,
    ablation_lift_scores_json jsonb,
    by_task_mode_json jsonb,
    last_eval_run_id integer,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: bundle_evals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.bundle_evals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bundle_evals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bundle_evals_id_seq OWNED BY public.bundle_evals.id;


--
-- Name: claim_purge_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.claim_purge_logs (
    id integer NOT NULL,
    purged_at timestamp without time zone DEFAULT now() NOT NULL,
    rows_deleted integer NOT NULL,
    retention_days integer NOT NULL
);


--
-- Name: claim_purge_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.claim_purge_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: claim_purge_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.claim_purge_logs_id_seq OWNED BY public.claim_purge_logs.id;


--
-- Name: custom_lane_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.custom_lane_types (
    id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    max_concurrent_claims integer DEFAULT 20 NOT NULL,
    heavy_job_slots integer DEFAULT 2 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: custom_lane_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.custom_lane_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_lane_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_lane_types_id_seq OWNED BY public.custom_lane_types.id;


--
-- Name: design_intelligence_bookmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.design_intelligence_bookmarks (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: design_intelligence_bookmarks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.design_intelligence_bookmarks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: design_intelligence_bookmarks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.design_intelligence_bookmarks_id_seq OWNED BY public.design_intelligence_bookmarks.id;


--
-- Name: design_intelligence_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.design_intelligence_entries (
    id integer NOT NULL,
    source_id integer NOT NULL,
    category text NOT NULL,
    name text NOT NULL,
    data_json jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: design_intelligence_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.design_intelligence_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: design_intelligence_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.design_intelligence_entries_id_seq OWNED BY public.design_intelligence_entries.id;


--
-- Name: eval_run_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.eval_run_variants (
    id integer NOT NULL,
    run_id integer NOT NULL,
    variant_type text DEFAULT 'treatment'::text NOT NULL,
    skill_ids_included_json jsonb,
    skill_ids_excluded_json jsonb,
    time_to_first_answer_ms integer,
    total_elapsed_ms integer,
    memory_items_retrieved integer,
    context_bytes_injected integer,
    shielded_bytes_avoided integer,
    repo_hit_count integer,
    repo_cache_hit integer,
    success boolean,
    user_rating integer,
    cost_usd real,
    raw_score real,
    composite_score real,
    scoring_weights_json jsonb,
    metrics_json jsonb,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_run_variants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.eval_run_variants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: eval_run_variants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.eval_run_variants_id_seq OWNED BY public.eval_run_variants.id;


--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.eval_runs (
    id integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    run_type text DEFAULT 'bundle'::text NOT NULL,
    target_skill_id integer,
    target_bundle_id integer,
    task_mode text DEFAULT 'build'::text NOT NULL,
    session_type text DEFAULT 'solo'::text NOT NULL,
    token_mode text DEFAULT 'core'::text NOT NULL,
    model_profile text DEFAULT 'kimi'::text NOT NULL,
    repo_kind text,
    repo_langs_json jsonb,
    repo_commit_sha text,
    skill_version_ids_json jsonb,
    bundle_version_hash text,
    config_version text DEFAULT '1'::text NOT NULL,
    scoring_weights_json jsonb,
    priority integer DEFAULT 3 NOT NULL,
    cost_cap_usd real,
    estimated_cost_usd real,
    actual_cost_usd real,
    error_details text,
    notes text,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.eval_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: eval_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.eval_runs_id_seq OWNED BY public.eval_runs.id;


--
-- Name: gpu_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.gpu_profiles (
    id integer NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    gpu_name text NOT NULL,
    num_gpus integer NOT NULL,
    total_vram integer NOT NULL,
    docker_image_tag text NOT NULL,
    default_quant text NOT NULL,
    quant_size_gb integer NOT NULL,
    disk_size_gb integer NOT NULL,
    estimated_speed_min real NOT NULL,
    estimated_speed_max real NOT NULL,
    estimated_cost_min real NOT NULL,
    estimated_cost_max real NOT NULL,
    llama_ctx_size integer DEFAULT 32768 NOT NULL,
    llama_batch_size integer DEFAULT 512 NOT NULL,
    llama_extra_args text DEFAULT ''::text,
    search_params jsonb NOT NULL,
    startup_time_min integer DEFAULT 20 NOT NULL,
    model_repo text DEFAULT 'moonshotai/Kimi-K2.5'::text NOT NULL,
    served_model_name text DEFAULT 'kimi-k2'::text NOT NULL,
    model_display_name text DEFAULT 'Kimi K2.5'::text NOT NULL,
    swarm_worker_cap integer,
    benchmark_callout text,
    is_nim_workspace boolean DEFAULT false NOT NULL,
    nim_default_provider text,
    nim_model_id text,
    nim_types jsonb,
    nim_partner_providers jsonb
);


--
-- Name: gpu_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.gpu_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gpu_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gpu_profiles_id_seq OWNED BY public.gpu_profiles.id;


--
-- Name: lane_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lane_claims (
    id integer NOT NULL,
    lane_id integer NOT NULL,
    claim_type text NOT NULL,
    path_or_symbol text NOT NULL,
    claimed_at timestamp without time zone DEFAULT now() NOT NULL,
    last_heartbeat_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    claim_strength text DEFAULT 'watching'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    claim_symbols jsonb
);


--
-- Name: lane_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.lane_claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lane_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lane_claims_id_seq OWNED BY public.lane_claims.id;


--
-- Name: lane_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lane_events (
    id integer NOT NULL,
    session_id integer NOT NULL,
    lane_id integer NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: lane_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.lane_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lane_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lane_events_id_seq OWNED BY public.lane_events.id;


--
-- Name: lane_handoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lane_handoffs (
    id integer NOT NULL,
    lane_id integer NOT NULL,
    handoff_type text NOT NULL,
    notes text,
    related_lane_id integer,
    watch_files jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    acknowledged_at timestamp without time zone,
    pr_url text
);


--
-- Name: lane_handoffs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.lane_handoffs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lane_handoffs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lane_handoffs_id_seq OWNED BY public.lane_handoffs.id;


--
-- Name: lane_heavy_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lane_heavy_jobs (
    id integer NOT NULL,
    session_id integer NOT NULL,
    lane_id integer,
    job_class text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    age_weight real DEFAULT 0 NOT NULL,
    lane_weight real DEFAULT 1 NOT NULL,
    effective_score real DEFAULT 0 NOT NULL,
    payload jsonb,
    result jsonb,
    error_details text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    deferred_until timestamp without time zone
);


--
-- Name: lane_heavy_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.lane_heavy_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lane_heavy_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lane_heavy_jobs_id_seq OWNED BY public.lane_heavy_jobs.id;


--
-- Name: nim_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.nim_catalog (
    nim_model_id text NOT NULL,
    display_name text NOT NULL,
    nim_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    partner_providers jsonb DEFAULT '[]'::jsonb NOT NULL,
    short_description text,
    usecase_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    context_length text,
    synced_at timestamp without time zone DEFAULT now() NOT NULL,
    swe_bench_score real,
    benchmark_variant text,
    throughput_class text
);


--
-- Name: operator_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.operator_credentials (
    id integer NOT NULL,
    provider text NOT NULL,
    access_token_encrypted text NOT NULL,
    github_login text,
    github_avatar_url text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.operator_credentials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: operator_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.operator_credentials_id_seq OWNED BY public.operator_credentials.id;


--
-- Name: orchestration_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.orchestration_idempotency (
    idempotency_key text NOT NULL,
    session_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: palette_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.palette_intents (
    id integer NOT NULL,
    user_id text DEFAULT 'operator'::text NOT NULL,
    query text NOT NULL,
    ok boolean NOT NULL,
    action text,
    payload_json jsonb,
    explanation text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: palette_intents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.palette_intents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: palette_intents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.palette_intents_id_seq OWNED BY public.palette_intents.id;


--
-- Name: provisioned_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.provisioned_resources (
    id integer NOT NULL,
    session_id integer NOT NULL,
    type text NOT NULL,
    resource_id text,
    connection_string text,
    schema_template_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    deleted_at timestamp without time zone
);


--
-- Name: provisioned_resources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.provisioned_resources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provisioned_resources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.provisioned_resources_id_seq OWNED BY public.provisioned_resources.id;


--
-- Name: repo_graph_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.repo_graph_jobs (
    id integer NOT NULL,
    session_id integer NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    graph_path text,
    indexed_symbols integer,
    last_run_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    repo_path text,
    edge_count integer,
    retrieval_status text,
    index_version integer DEFAULT 1 NOT NULL,
    embeddings_status text,
    error_details text,
    content_hash_seed text,
    duration_ms integer
);


--
-- Name: repo_graph_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.repo_graph_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: repo_graph_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.repo_graph_jobs_id_seq OWNED BY public.repo_graph_jobs.id;


--
-- Name: scheduler_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.scheduler_config (
    id integer NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    profile_id integer,
    launch_time text DEFAULT '09:00'::text NOT NULL,
    stop_time text DEFAULT '19:00'::text NOT NULL,
    second_reminder_time text DEFAULT '00:00'::text NOT NULL,
    days_of_week text[] DEFAULT ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text] NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    team_member_names text[] DEFAULT ARRAY[]::text[] NOT NULL,
    repo_url text
);


--
-- Name: scheduler_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.scheduler_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheduler_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scheduler_config_id_seq OWNED BY public.scheduler_config.id;


--
-- Name: schema_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.schema_templates (
    id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    sql_content text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.schema_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_templates_id_seq OWNED BY public.schema_templates.id;


--
-- Name: session_lanes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.session_lanes (
    id integer NOT NULL,
    session_id integer NOT NULL,
    member_identifier text NOT NULL,
    lane_type text DEFAULT 'general'::text NOT NULL,
    task_mode text DEFAULT 'build'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    overlay_bundle_id integer,
    token_mode text DEFAULT 'core'::text NOT NULL,
    current_task text,
    handoff_data jsonb,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: session_lanes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.session_lanes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_lanes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_lanes_id_seq OWNED BY public.session_lanes.id;


--
-- Name: session_model_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.session_model_switches (
    id integer NOT NULL,
    session_id integer NOT NULL,
    from_model_id text,
    from_provider text,
    to_model_id text NOT NULL,
    to_provider text NOT NULL,
    phase text,
    triggered_by text DEFAULT 'manual'::text NOT NULL,
    reason text,
    switched_at timestamp without time zone DEFAULT now() NOT NULL,
    tokens_in integer,
    tokens_out integer,
    cost_usd numeric(12,8)
);


--
-- Name: session_model_switches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.session_model_switches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_model_switches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_model_switches_id_seq OWNED BY public.session_model_switches.id;


--
-- Name: session_repo_context; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.session_repo_context (
    id integer NOT NULL,
    session_id integer NOT NULL,
    repo_path text NOT NULL,
    repo_url text,
    fingerprint_json jsonb,
    fingerprint_hash text,
    summary_json jsonb,
    symbols_json jsonb,
    files_json jsonb,
    edges_json jsonb,
    index_status text DEFAULT 'queued'::text NOT NULL,
    is_stale boolean DEFAULT false NOT NULL,
    confidence_level text DEFAULT 'none'::text NOT NULL,
    indexed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    chunks_json jsonb,
    embeddings_json jsonb,
    has_embeddings boolean DEFAULT false NOT NULL,
    embedding_dim integer
);


--
-- Name: session_repo_context_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.session_repo_context_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_repo_context_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_repo_context_id_seq OWNED BY public.session_repo_context.id;


--
-- Name: session_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.session_skills (
    id integer NOT NULL,
    session_id integer NOT NULL,
    bundle_id integer,
    activated_skills_json jsonb NOT NULL,
    rationale_json jsonb,
    token_mode text DEFAULT 'core'::text NOT NULL,
    activation_mode text DEFAULT 'boot'::text NOT NULL,
    activated_at timestamp without time zone DEFAULT now() NOT NULL,
    design_context_json jsonb
);


--
-- Name: session_skills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.session_skills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_skills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_skills_id_seq OWNED BY public.session_skills.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.sessions (
    id integer NOT NULL,
    profile_id integer NOT NULL,
    vast_instance_id integer,
    vast_offer_id integer,
    template_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    status_message text,
    bolt_diy_url text,
    code_server_url text,
    preview_url text,
    ssh_host text,
    ssh_port integer,
    public_ip text,
    cost_per_hour real,
    total_cost real DEFAULT 0,
    gpu_name text,
    num_gpus integer,
    started_at timestamp without time zone,
    stopped_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    team_members jsonb,
    task_mode text,
    token_mode text,
    active_bundle_id integer,
    repo_fingerprint_json jsonb,
    routing_stats_json jsonb,
    swarm_snapshot_json jsonb,
    plan_snapshot_json jsonb,
    owner_token text,
    intent_text text,
    provider text DEFAULT 'vastai'::text NOT NULL,
    nim_provider text,
    nim_model_id text,
    has_github_token boolean DEFAULT false NOT NULL,
    fly_machine_id text,
    current_phase text,
    active_nim_model_id text,
    active_nim_provider text,
    model_routing_mode text DEFAULT 'auto'::text
);


--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;


--
-- Name: skill_bundles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_bundles (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    bundle_json jsonb NOT NULL,
    session_mode text,
    task_mode text,
    repo_kind text,
    model_family text,
    token_mode text DEFAULT 'core'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_bundles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_bundles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_bundles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_bundles_id_seq OWNED BY public.skill_bundles.id;


--
-- Name: skill_design_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_design_categories (
    id integer NOT NULL,
    skill_id integer NOT NULL,
    category text NOT NULL,
    match_method text DEFAULT 'keyword'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_design_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_design_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_design_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_design_categories_id_seq OWNED BY public.skill_design_categories.id;


--
-- Name: skill_evals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_evals (
    id integer NOT NULL,
    skill_id integer NOT NULL,
    activation_count integer DEFAULT 0 NOT NULL,
    eval_appearances integer DEFAULT 0 NOT NULL,
    positive_lift_count integer DEFAULT 0 NOT NULL,
    negative_lift_count integer DEFAULT 0 NOT NULL,
    confidence_score real DEFAULT 0 NOT NULL,
    estimated_contribution real DEFAULT 0 NOT NULL,
    last_eval_run_id integer,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_evals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_evals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_evals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_evals_id_seq OWNED BY public.skill_evals.id;


--
-- Name: skill_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_feedback (
    id integer NOT NULL,
    session_id integer NOT NULL,
    skill_id integer NOT NULL,
    helpful boolean NOT NULL,
    notes text,
    token_delta integer,
    task_success_score integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_feedback_id_seq OWNED BY public.skill_feedback.id;


--
-- Name: skill_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_sources (
    id integer NOT NULL,
    repo_url text NOT NULL,
    source_type text DEFAULT 'github'::text NOT NULL,
    default_branch text DEFAULT 'main'::text NOT NULL,
    pinned_commit_sha text,
    license text,
    trust_level text DEFAULT 'user_approved'::text NOT NULL,
    imported_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_sources_id_seq OWNED BY public.skill_sources.id;


--
-- Name: skill_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skill_versions (
    id integer NOT NULL,
    skill_id integer NOT NULL,
    manifest_json jsonb NOT NULL,
    extracted_rules_json jsonb,
    source_files_json jsonb,
    version_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skill_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_versions_id_seq OWNED BY public.skill_versions.id;


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.skills (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    class text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    source_id integer,
    trust_tier text DEFAULT 'user_approved'::text NOT NULL,
    install_risk text DEFAULT 'virtual'::text NOT NULL,
    token_overhead_estimate integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    review_status text DEFAULT 'pending'::text NOT NULL,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: skills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.skills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skills_id_seq OWNED BY public.skills.id;


--
-- Name: templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.templates (
    id integer NOT NULL,
    template_hash text NOT NULL,
    name text NOT NULL,
    image text NOT NULL,
    on_start_script text,
    env_vars text,
    is_default boolean DEFAULT false NOT NULL,
    profile_id integer,
    disk_space integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.templates_id_seq OWNED BY public.templates.id;


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: bundle_evals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_evals ALTER COLUMN id SET DEFAULT nextval('public.bundle_evals_id_seq'::regclass);


--
-- Name: claim_purge_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_purge_logs ALTER COLUMN id SET DEFAULT nextval('public.claim_purge_logs_id_seq'::regclass);


--
-- Name: custom_lane_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_lane_types ALTER COLUMN id SET DEFAULT nextval('public.custom_lane_types_id_seq'::regclass);


--
-- Name: design_intelligence_bookmarks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_bookmarks ALTER COLUMN id SET DEFAULT nextval('public.design_intelligence_bookmarks_id_seq'::regclass);


--
-- Name: design_intelligence_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_entries ALTER COLUMN id SET DEFAULT nextval('public.design_intelligence_entries_id_seq'::regclass);


--
-- Name: eval_run_variants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_variants ALTER COLUMN id SET DEFAULT nextval('public.eval_run_variants_id_seq'::regclass);


--
-- Name: eval_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs ALTER COLUMN id SET DEFAULT nextval('public.eval_runs_id_seq'::regclass);


--
-- Name: gpu_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpu_profiles ALTER COLUMN id SET DEFAULT nextval('public.gpu_profiles_id_seq'::regclass);


--
-- Name: lane_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_claims ALTER COLUMN id SET DEFAULT nextval('public.lane_claims_id_seq'::regclass);


--
-- Name: lane_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_events ALTER COLUMN id SET DEFAULT nextval('public.lane_events_id_seq'::regclass);


--
-- Name: lane_handoffs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_handoffs ALTER COLUMN id SET DEFAULT nextval('public.lane_handoffs_id_seq'::regclass);


--
-- Name: lane_heavy_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_heavy_jobs ALTER COLUMN id SET DEFAULT nextval('public.lane_heavy_jobs_id_seq'::regclass);


--
-- Name: operator_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_credentials ALTER COLUMN id SET DEFAULT nextval('public.operator_credentials_id_seq'::regclass);


--
-- Name: palette_intents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.palette_intents ALTER COLUMN id SET DEFAULT nextval('public.palette_intents_id_seq'::regclass);


--
-- Name: provisioned_resources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioned_resources ALTER COLUMN id SET DEFAULT nextval('public.provisioned_resources_id_seq'::regclass);


--
-- Name: repo_graph_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_graph_jobs ALTER COLUMN id SET DEFAULT nextval('public.repo_graph_jobs_id_seq'::regclass);


--
-- Name: scheduler_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_config ALTER COLUMN id SET DEFAULT nextval('public.scheduler_config_id_seq'::regclass);


--
-- Name: schema_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_templates ALTER COLUMN id SET DEFAULT nextval('public.schema_templates_id_seq'::regclass);


--
-- Name: session_lanes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_lanes ALTER COLUMN id SET DEFAULT nextval('public.session_lanes_id_seq'::regclass);


--
-- Name: session_model_switches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_model_switches ALTER COLUMN id SET DEFAULT nextval('public.session_model_switches_id_seq'::regclass);


--
-- Name: session_repo_context id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_repo_context ALTER COLUMN id SET DEFAULT nextval('public.session_repo_context_id_seq'::regclass);


--
-- Name: session_skills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_skills ALTER COLUMN id SET DEFAULT nextval('public.session_skills_id_seq'::regclass);


--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);


--
-- Name: skill_bundles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_bundles ALTER COLUMN id SET DEFAULT nextval('public.skill_bundles_id_seq'::regclass);


--
-- Name: skill_design_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_design_categories ALTER COLUMN id SET DEFAULT nextval('public.skill_design_categories_id_seq'::regclass);


--
-- Name: skill_evals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_evals ALTER COLUMN id SET DEFAULT nextval('public.skill_evals_id_seq'::regclass);


--
-- Name: skill_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_feedback ALTER COLUMN id SET DEFAULT nextval('public.skill_feedback_id_seq'::regclass);


--
-- Name: skill_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_sources ALTER COLUMN id SET DEFAULT nextval('public.skill_sources_id_seq'::regclass);


--
-- Name: skill_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_versions ALTER COLUMN id SET DEFAULT nextval('public.skill_versions_id_seq'::regclass);


--
-- Name: skills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills ALTER COLUMN id SET DEFAULT nextval('public.skills_id_seq'::regclass);


--
-- Name: templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates ALTER COLUMN id SET DEFAULT nextval('public.templates_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: bundle_evals bundle_evals_bundle_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_evals
    ADD CONSTRAINT bundle_evals_bundle_id_unique UNIQUE (bundle_id);


--
-- Name: bundle_evals bundle_evals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_evals
    ADD CONSTRAINT bundle_evals_pkey PRIMARY KEY (id);


--
-- Name: claim_purge_logs claim_purge_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_purge_logs
    ADD CONSTRAINT claim_purge_logs_pkey PRIMARY KEY (id);


--
-- Name: custom_lane_types custom_lane_types_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_lane_types
    ADD CONSTRAINT custom_lane_types_name_unique UNIQUE (name);


--
-- Name: custom_lane_types custom_lane_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_lane_types
    ADD CONSTRAINT custom_lane_types_pkey PRIMARY KEY (id);


--
-- Name: design_intelligence_bookmarks design_intelligence_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_bookmarks
    ADD CONSTRAINT design_intelligence_bookmarks_pkey PRIMARY KEY (id);


--
-- Name: design_intelligence_entries design_intelligence_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_entries
    ADD CONSTRAINT design_intelligence_entries_pkey PRIMARY KEY (id);


--
-- Name: eval_run_variants eval_run_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_variants
    ADD CONSTRAINT eval_run_variants_pkey PRIMARY KEY (id);


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);


--
-- Name: gpu_profiles gpu_profiles_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpu_profiles
    ADD CONSTRAINT gpu_profiles_name_unique UNIQUE (name);


--
-- Name: gpu_profiles gpu_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gpu_profiles
    ADD CONSTRAINT gpu_profiles_pkey PRIMARY KEY (id);


--
-- Name: lane_claims lane_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_claims
    ADD CONSTRAINT lane_claims_pkey PRIMARY KEY (id);


--
-- Name: lane_events lane_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_events
    ADD CONSTRAINT lane_events_pkey PRIMARY KEY (id);


--
-- Name: lane_handoffs lane_handoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_handoffs
    ADD CONSTRAINT lane_handoffs_pkey PRIMARY KEY (id);


--
-- Name: lane_heavy_jobs lane_heavy_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_heavy_jobs
    ADD CONSTRAINT lane_heavy_jobs_pkey PRIMARY KEY (id);


--
-- Name: nim_catalog nim_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nim_catalog
    ADD CONSTRAINT nim_catalog_pkey PRIMARY KEY (nim_model_id);


--
-- Name: operator_credentials operator_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_credentials
    ADD CONSTRAINT operator_credentials_pkey PRIMARY KEY (id);


--
-- Name: orchestration_idempotency orchestration_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orchestration_idempotency
    ADD CONSTRAINT orchestration_idempotency_pkey PRIMARY KEY (idempotency_key);


--
-- Name: palette_intents palette_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.palette_intents
    ADD CONSTRAINT palette_intents_pkey PRIMARY KEY (id);


--
-- Name: provisioned_resources provisioned_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioned_resources
    ADD CONSTRAINT provisioned_resources_pkey PRIMARY KEY (id);


--
-- Name: repo_graph_jobs repo_graph_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.repo_graph_jobs
    ADD CONSTRAINT repo_graph_jobs_pkey PRIMARY KEY (id);


--
-- Name: scheduler_config scheduler_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_config
    ADD CONSTRAINT scheduler_config_pkey PRIMARY KEY (id);


--
-- Name: schema_templates schema_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_templates
    ADD CONSTRAINT schema_templates_pkey PRIMARY KEY (id);


--
-- Name: session_lanes session_lanes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_lanes
    ADD CONSTRAINT session_lanes_pkey PRIMARY KEY (id);


--
-- Name: session_model_switches session_model_switches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_model_switches
    ADD CONSTRAINT session_model_switches_pkey PRIMARY KEY (id);


--
-- Name: session_repo_context session_repo_context_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_repo_context
    ADD CONSTRAINT session_repo_context_pkey PRIMARY KEY (id);


--
-- Name: session_skills session_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_skills
    ADD CONSTRAINT session_skills_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: skill_bundles skill_bundles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_pkey PRIMARY KEY (id);


--
-- Name: skill_bundles skill_bundles_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_bundles
    ADD CONSTRAINT skill_bundles_slug_unique UNIQUE (slug);


--
-- Name: skill_design_categories skill_design_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_design_categories
    ADD CONSTRAINT skill_design_categories_pkey PRIMARY KEY (id);


--
-- Name: skill_evals skill_evals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_evals
    ADD CONSTRAINT skill_evals_pkey PRIMARY KEY (id);


--
-- Name: skill_evals skill_evals_skill_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_evals
    ADD CONSTRAINT skill_evals_skill_id_unique UNIQUE (skill_id);


--
-- Name: skill_feedback skill_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_feedback
    ADD CONSTRAINT skill_feedback_pkey PRIMARY KEY (id);


--
-- Name: skill_sources skill_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_sources
    ADD CONSTRAINT skill_sources_pkey PRIMARY KEY (id);


--
-- Name: skill_versions skill_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: skills skills_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_slug_unique UNIQUE (slug);


--
-- Name: templates templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_pkey PRIMARY KEY (id);


--
-- Name: design_intel_source_category_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS design_intel_source_category_name_unique ON public.design_intelligence_entries USING btree (source_id, category, name);


--
-- Name: design_intelligence_bookmarks_entry_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS design_intelligence_bookmarks_entry_unique ON public.design_intelligence_bookmarks USING btree (entry_id);


--
-- Name: lane_claims_active_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS lane_claims_active_unique_idx ON public.lane_claims USING btree (lane_id, path_or_symbol) WHERE (active = true);


--
-- Name: operator_credentials_provider_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS operator_credentials_provider_unique ON public.operator_credentials USING btree (provider);


--
-- Name: orchestration_idempotency_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS orchestration_idempotency_created_at_idx ON public.orchestration_idempotency USING btree (created_at);


--
-- Name: skill_design_category_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS skill_design_category_unique ON public.skill_design_categories USING btree (skill_id, category);


--
-- Name: skill_feedback_session_skill_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS skill_feedback_session_skill_unique ON public.skill_feedback USING btree (session_id, skill_id);


--
-- Name: bundle_evals bundle_evals_bundle_id_skill_bundles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_evals
    ADD CONSTRAINT bundle_evals_bundle_id_skill_bundles_id_fk FOREIGN KEY (bundle_id) REFERENCES public.skill_bundles(id);


--
-- Name: bundle_evals bundle_evals_last_eval_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_evals
    ADD CONSTRAINT bundle_evals_last_eval_run_id_eval_runs_id_fk FOREIGN KEY (last_eval_run_id) REFERENCES public.eval_runs(id);


--
-- Name: design_intelligence_bookmarks design_intelligence_bookmarks_entry_id_design_intelligence_entr; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_bookmarks
    ADD CONSTRAINT design_intelligence_bookmarks_entry_id_design_intelligence_entr FOREIGN KEY (entry_id) REFERENCES public.design_intelligence_entries(id) ON DELETE CASCADE;


--
-- Name: design_intelligence_entries design_intelligence_entries_source_id_skill_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_intelligence_entries
    ADD CONSTRAINT design_intelligence_entries_source_id_skill_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.skill_sources(id);


--
-- Name: eval_run_variants eval_run_variants_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_run_variants
    ADD CONSTRAINT eval_run_variants_run_id_eval_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.eval_runs(id);


--
-- Name: eval_runs eval_runs_target_bundle_id_skill_bundles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_target_bundle_id_skill_bundles_id_fk FOREIGN KEY (target_bundle_id) REFERENCES public.skill_bundles(id);


--
-- Name: eval_runs eval_runs_target_skill_id_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_target_skill_id_skills_id_fk FOREIGN KEY (target_skill_id) REFERENCES public.skills(id);


--
-- Name: lane_claims lane_claims_lane_id_session_lanes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_claims
    ADD CONSTRAINT lane_claims_lane_id_session_lanes_id_fk FOREIGN KEY (lane_id) REFERENCES public.session_lanes(id);


--
-- Name: lane_events lane_events_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_events
    ADD CONSTRAINT lane_events_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: lane_handoffs lane_handoffs_lane_id_session_lanes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_handoffs
    ADD CONSTRAINT lane_handoffs_lane_id_session_lanes_id_fk FOREIGN KEY (lane_id) REFERENCES public.session_lanes(id);


--
-- Name: lane_heavy_jobs lane_heavy_jobs_lane_id_session_lanes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_heavy_jobs
    ADD CONSTRAINT lane_heavy_jobs_lane_id_session_lanes_id_fk FOREIGN KEY (lane_id) REFERENCES public.session_lanes(id);


--
-- Name: lane_heavy_jobs lane_heavy_jobs_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lane_heavy_jobs
    ADD CONSTRAINT lane_heavy_jobs_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: orchestration_idempotency orchestration_idempotency_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orchestration_idempotency
    ADD CONSTRAINT orchestration_idempotency_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: provisioned_resources provisioned_resources_schema_template_id_schema_templates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioned_resources
    ADD CONSTRAINT provisioned_resources_schema_template_id_schema_templates_id_fk FOREIGN KEY (schema_template_id) REFERENCES public.schema_templates(id);


--
-- Name: provisioned_resources provisioned_resources_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisioned_resources
    ADD CONSTRAINT provisioned_resources_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: scheduler_config scheduler_config_profile_id_gpu_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduler_config
    ADD CONSTRAINT scheduler_config_profile_id_gpu_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.gpu_profiles(id);


--
-- Name: session_lanes session_lanes_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_lanes
    ADD CONSTRAINT session_lanes_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id);


--
-- Name: session_model_switches session_model_switches_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_model_switches
    ADD CONSTRAINT session_model_switches_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: session_skills session_skills_bundle_id_skill_bundles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_skills
    ADD CONSTRAINT session_skills_bundle_id_skill_bundles_id_fk FOREIGN KEY (bundle_id) REFERENCES public.skill_bundles(id);


--
-- Name: sessions sessions_active_bundle_id_skill_bundles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_active_bundle_id_skill_bundles_id_fk FOREIGN KEY (active_bundle_id) REFERENCES public.skill_bundles(id);


--
-- Name: sessions sessions_profile_id_gpu_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_profile_id_gpu_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.gpu_profiles(id);


--
-- Name: skill_design_categories skill_design_categories_skill_id_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_design_categories
    ADD CONSTRAINT skill_design_categories_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: skill_evals skill_evals_last_eval_run_id_eval_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_evals
    ADD CONSTRAINT skill_evals_last_eval_run_id_eval_runs_id_fk FOREIGN KEY (last_eval_run_id) REFERENCES public.eval_runs(id);


--
-- Name: skill_evals skill_evals_skill_id_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_evals
    ADD CONSTRAINT skill_evals_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id);


--
-- Name: skill_feedback skill_feedback_skill_id_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_feedback
    ADD CONSTRAINT skill_feedback_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id);


--
-- Name: skill_versions skill_versions_skill_id_skills_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_versions
    ADD CONSTRAINT skill_versions_skill_id_skills_id_fk FOREIGN KEY (skill_id) REFERENCES public.skills(id);


--
-- Name: skills skills_source_id_skill_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_source_id_skill_sources_id_fk FOREIGN KEY (source_id) REFERENCES public.skill_sources(id);


--
-- Name: templates templates_profile_id_gpu_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates
    ADD CONSTRAINT templates_profile_id_gpu_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.gpu_profiles(id);


--
-- PostgreSQL database dump complete
--



