# Upstream test inventory

Source: router-for-me/CLIProxyAPI @ 9717e325 (2026-10-28), plus v7.0.12 for the Gemini CLI OAuth path that the current upstream no longer ships.

Every `*_test.go` under `test/`, `internal/` and `sdk/` is listed with its disposition:

- **port**: ported to `bun:test` (the TS test file cites the Go source in its header).
Totals: 1127 test files; port=241, review=228, skip=658.
- **skip**: not ported; reason given.
- **review**: candidate; ported only where the kept code path reproduces the behaviour. The `Ported as` column is filled in from the TS test headers.

## `internal/api`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `github_token_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `home_models_empty_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `max_request_body_bytes_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `mux_listener_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `protocol_multiplexer_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `redis_queue_protocol_integration_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `response_compression_bench_test.go` | skip | Go benchmark / race-detector harness | |
| `response_compression_review_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `response_compression_server_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `response_compression_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `runtime_reload_regression_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_apply_patch_config_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_claude_tool_search_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_codex_search_siwc_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_config_v8_etag_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_cors_preflight_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_devin_oauth_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_grok_models_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_home_tool_search_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_kimi_oauth_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_management_v8_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_model_detail_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_models_interceptor_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_multi_agent_config_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_sdk_config_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_siwc_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_stop_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `server_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |

## `internal/api/handlers/management`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `api_key_usage_test.go` | skip | Management API (out of scope) | |
| `api_tools_test.go` | skip | Management API (out of scope) | |
| `auth_files_batch_test.go` | skip | Management API (out of scope) | |
| `auth_files_cooldown_test.go` | skip | Management API (out of scope) | |
| `auth_files_delete_test.go` | skip | Management API (out of scope) | |
| `auth_files_devin_oauth_test.go` | skip | Management API (out of scope) | |
| `auth_files_download_test.go` | skip | Management API (out of scope) | |
| `auth_files_download_windows_test.go` | skip | Management API (out of scope) | |
| `auth_files_excluded_models_test.go` | skip | Management API (out of scope) | |
| `auth_files_filter_test.go` | skip | Management API (out of scope) | |
| `auth_files_pagination_test.go` | skip | Management API (out of scope) | |
| `auth_files_patch_fields_test.go` | skip | Management API (out of scope) | |
| `auth_files_plugin_oauth_test.go` | skip | Management API (out of scope) | |
| `auth_files_project_id_test.go` | skip | Management API (out of scope) | |
| `auth_files_provider_meta_oauth_test.go` | skip | Management API (out of scope) | |
| `auth_files_quota_test.go` | skip | Management API (out of scope) | |
| `auth_files_recent_requests_test.go` | skip | Management API (out of scope) | |
| `auth_files_refresh_test.go` | skip | Management API (out of scope) | |
| `auth_files_relogin_preserve_test.go` | skip | Management API (out of scope) | |
| `auth_files_status_sync_test.go` | skip | Management API (out of scope) | |
| `auth_files_upload_test.go` | skip | Management API (out of scope) | |
| `config_apikey_disable_test.go` | skip | Management API (out of scope) | |
| `config_basic_version_test.go` | skip | Management API (out of scope) | |
| `config_basic_weight_test.go` | skip | Management API (out of scope) | |
| `config_claude_key_test.go` | skip | Management API (out of scope) | |
| `config_codex_alpha_search_test.go` | skip | Management API (out of scope) | |
| `config_codex_disable_cloaking_test.go` | skip | Management API (out of scope) | |
| `config_disable_cooling_test.go` | skip | Management API (out of scope) | |
| `config_lists_delete_keys_test.go` | skip | Management API (out of scope) | |
| `config_meta_key_test.go` | skip | Management API (out of scope) | |
| `config_openai_compat_test.go` | skip | Management API (out of scope) | |
| `config_priority_test.go` | skip | Management API (out of scope) | |
| `config_reload_fence_test.go` | skip | Management API (out of scope) | |
| `config_v8_auth_index_test.go` | skip | Management API (out of scope) | |
| `config_v8_client_test.go` | skip | Management API (out of scope) | |
| `config_v8_compatibility_test.go` | skip | Management API (out of scope) | |
| `config_v8_etag_test.go` | skip | Management API (out of scope) | |
| `config_v8_test.go` | skip | Management API (out of scope) | |
| `config_v8_upstream_test.go` | skip | Management API (out of scope) | |
| `config_weight_test.go` | skip | Management API (out of scope) | |
| `config_xai_key_test.go` | skip | Management API (out of scope) | |
| `handler_test.go` | skip | Management API (out of scope) | |
| `logs_test.go` | skip | Management API (out of scope) | |
| `model_definitions_test.go` | skip | Management API (out of scope) | |
| `oauth_callback_test.go` | skip | Management API (out of scope) | |
| `oauth_codex_concurrency_test.go` | skip | Management API (out of scope) | |
| `oauth_session_proxy_test.go` | skip | Management API (out of scope) | |
| `oauth_sessions_test.go` | skip | Management API (out of scope) | |
| `oauth_siwc_mutations_test.go` | skip | Management API (out of scope) | |
| `oauth_siwc_test.go` | skip | Management API (out of scope) | |
| `plugin_quota_test.go` | skip | Management API (out of scope) | |
| `plugin_store_release_test.go` | skip | Management API (out of scope) | |
| `plugin_store_test.go` | skip | Management API (out of scope) | |
| `plugins_test.go` | skip | Management API (out of scope) | |
| `quota_test.go` | skip | Management API (out of scope) | |
| `test_main_test.go` | skip | Management API (out of scope) | |
| `test_store_test.go` | skip | Management API (out of scope) | |
| `usage_test.go` | skip | Management API (out of scope) | |

## `internal/api/middleware`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `request_logging_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |
| `response_writer_test.go` | skip | Gin server plumbing; Claude inbound only (see sdk/api/handlers/claude) | |

## `internal/auth/antigravity`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `auth_test.go` | skip | dropped provider | |

## `internal/auth/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `anthropic_auth_proxy_test.go` | skip | Go uTLS / transport specific | |
| `anthropic_auth_test.go` | port | OAuth flow for kept provider | |
| `filename_test.go` | port | OAuth flow for kept provider | |
| `identity_test.go` | port | OAuth flow for kept provider | |
| `oauth_response_test.go` | port | OAuth flow for kept provider | |
| `token_test.go` | port | OAuth flow for kept provider | |
| `utls_transport_test.go` | skip | Go uTLS / transport specific | |

## `internal/auth/codex`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `filename_test.go` | port | OAuth flow for kept provider | |
| `jwt_parser_test.go` | port | OAuth flow for kept provider | |
| `openai_auth_test.go` | port | OAuth flow for kept provider | |
| `refresh_patch_test.go` | port | OAuth flow for kept provider | |
| `siwc_auth_test.go` | skip | Sign-in-with-ChatGPT flow (out of scope) | |
| `token_test.go` | port | OAuth flow for kept provider | |

## `internal/auth/devin`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `devin_auth_test.go` | skip | dropped provider | |
| `record_test.go` | skip | dropped provider | |
| `user_status_test.go` | skip | dropped provider | |

## `internal/auth/kimi`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `kimi_proxy_test.go` | skip | dropped provider | |
| `kimi_refresh_test.go` | skip | dropped provider | |
| `kimi_test.go` | skip | dropped provider | |

## `internal/auth/meta`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `meta_auth_test.go` | skip | dropped provider | |

## `internal/auth/xai`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `xai_auth_test.go` | skip | dropped provider | |

## `internal/cache`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_interactions_session_test.go` | skip | dropped provider | |
| `antigravity_reasoning_replay_cache_test.go` | skip | dropped provider | |
| `bounded_lru_test.go` | port | reasoning / signature replay caches | |
| `claude_thinking_replay_cache_test.go` | port | reasoning / signature replay caches | |
| `claude_web_search_result_cache_test.go` | port | reasoning / signature replay caches | |
| `codex_reasoning_replay_cache_test.go` | port | reasoning / signature replay caches | |
| `issue6332_delivery_test.go` | skip | dropped provider | |
| `issue6332_export_test.go` | skip | dropped provider | |
| `kimi_thinking_replay_cache_test.go` | skip | dropped provider | |
| `signature_cache_test.go` | port | reasoning / signature replay caches | |
| `xai_reasoning_replay_cache_test.go` | skip | dropped provider | |

## `internal/client/claude/models`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `models_test.go` | port | Claude /v1/models response | |

## `internal/client/codex/apply-patch`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `tool_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/client/codex/live`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `capabilities_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_secret_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `live_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `media_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `tcp_proxy_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `websocket_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/client/codex/models`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `apply_patch_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `models_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `web_search_capability_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/client/codex/optimize-multi-agent-v2`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `optimize_multi_agent_v2_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `orphan_delegation_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/client/codex/tool-schema`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `tool_schema_integer_fields_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `tool_schema_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/client/grokbuild`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `grokbuild_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `keepalive_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/clienterror`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `client_error_test.go` | port | error status helpers | |

## `internal/cmd`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `discover_review_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `discover_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `siwc_bind_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/config`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `api_key_is_compat_test.go` | port | YAML config loading | |
| `claude_code_test.go` | port | YAML config loading | |
| `claude_fingerprint_profile_test.go` | skip | config feature not carried over | |
| `claude_header_defaults_test.go` | port | YAML config loading | |
| `client_optimize_test.go` | skip | config feature not carried over | |
| `client_test.go` | port | YAML config loading | |
| `cloak_save_test.go` | skip | config feature not carried over | |
| `clone_test.go` | port | YAML config loading | |
| `codex_compression_test.go` | skip | config feature not carried over | |
| `codex_live_test.go` | skip | config feature not carried over | |
| `codex_websocket_header_defaults_test.go` | skip | config feature not carried over | |
| `config_load_test.go` | port | YAML config loading | |
| `config_meta_test.go` | port | YAML config loading | |
| `config_v8_comments_test.go` | skip | config feature not carried over | |
| `config_v8_save_layout_test.go` | skip | config feature not carried over | |
| `config_v8_test.go` | skip | config feature not carried over | |
| `cooling_override_test.go` | port | YAML config loading | |
| `credential_concurrency_fixture_test.go` | skip | config feature not carried over | |
| `credential_concurrency_test.go` | skip | config feature not carried over | |
| `credential_in_flight_test.go` | skip | config feature not carried over | |
| `disable_image_generation_mode_test.go` | skip | config feature not carried over | |
| `discovery_test.go` | skip | config feature not carried over | |
| `gemini_keys_normalization_test.go` | port | YAML config loading | |
| `github_token_test.go` | skip | config feature not carried over | |
| `home_test.go` | skip | config feature not carried over | |
| `is_compat_test.go` | port | YAML config loading | |
| `max_context_length_test.go` | port | YAML config loading | |
| `model_catalogs_test.go` | skip | config feature not carried over | |
| `model_display_name_test.go` | port | YAML config loading | |
| `oauth_model_alias_test.go` | port | YAML config loading | |
| `oauth_request_scoped_errors_test.go` | port | YAML config loading | |
| `oauth_scope_test.go` | port | YAML config loading | |
| `oauth_settings_test.go` | port | YAML config loading | |
| `plugin_config_save_test.go` | skip | config feature not carried over | |
| `plugin_config_test.go` | skip | config feature not carried over | |
| `remote_management_test.go` | skip | config feature not carried over | |
| `request_retry_test.go` | port | YAML config loading | |
| `request_scoped_errors_test.go` | port | YAML config loading | |
| `response_compression_test.go` | skip | config feature not carried over | |
| `shared_upstream_test.go` | skip | config feature not carried over | |
| `tls_handshake_timeout_test.go` | skip | config feature not carried over | |
| `trusted_proxies_test.go` | skip | config feature not carried over | |
| `use_max_completion_tokens_test.go` | skip | config feature not carried over | |
| `vertex_openapi_test.go` | skip | config feature not carried over | |
| `weight_test.go` | port | YAML config loading | |
| `xai_alpha_search_test.go` | skip | config feature not carried over | |
| `xai_api_key_test.go` | skip | config feature not carried over | |

## `internal/credentialweight`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `weight_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/discovery`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `browse_queries_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `browse_resolver_capacity_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `browse_resolver_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `discovery_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `service_review_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `spec_review_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `zeroconf_review_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/githubauth`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `token_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/home`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `client_cancellation_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_fence_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_latency_failure_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_latency_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_release_lifecycle_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_balance_recovery_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_balance_regression_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_balance_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_latency_cadence_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_latency_optimization_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cluster_latency_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `concurrency_release_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `in_flight_contract_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `kv_helpers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `plugin_status_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/homeplugins`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `network_scope_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `sync_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/htmlsanitize`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `htmlsanitize_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/httpfetch`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `httpfetch_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/httpwire`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `flush_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `ordered_conn_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/logging`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `cpa_trace_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `diagnostic_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `gin_logger_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `global_logger_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `home_app_log_forwarder_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `home_rebalance_log_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `log_dir_cleaner_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `request_logger_collision_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `request_logger_home_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `request_logger_traversal_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `requestid_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `requestmeta_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/managementasset`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `updater_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/misc`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_version_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `credentials_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/modelconfig`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `model_info_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/pluginhost`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `adapters_auth_body_slots_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_auth_body_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_disable_type_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_executors_count_tokens_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_executors_payload_rules_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_executors_thinking_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_executors_usage_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `adapters_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `affinity_callbacks_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `auth_callbacks_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `auth_model_provider_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `auth_provider_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `client_guard_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `command_line_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `config_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `host_callbacks_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `host_model_stream_callbacks_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `host_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `http_bridge_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `http_operation_bridge_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `issue6332_delivery_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `loader_unix_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `loader_windows_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `logging_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `management_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `model_router_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `native_catalog_priority_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `platform_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `plugin_refresh_compat_executor_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `quota_provider_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `request_lifecycle_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `routing_callbacks_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `rpc_client_error_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `rpc_client_stream_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `rpc_schema_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `scheduler_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `shadow_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `stream_bridge_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `test_helpers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `websocket_observer_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/pluginstore`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `auth_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `github_rate_limit_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `github_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `global_token_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `home_sync_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `install_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `registry_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `request_identity_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `version_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/redisqueue`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `plugin_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `queue_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/registry`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `catalog_devin_notification_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `catalog_policy_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `catalog_reload_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `catalog_sources_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `claude_family_lookup_test.go` | port | model registry | |
| `codex_client_models_test.go` | port | model registry | |
| `devin_models_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_definitions_test.go` | port | model registry | |
| `model_registry_cache_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_registry_credential_quota_regression_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_registry_grok_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_registry_hook_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_registry_quota_refresh_regression_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_registry_replace_test.go` | port | model registry | |
| `model_registry_safety_test.go` | port | model registry | |
| `model_registry_sole_credential_quota_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `model_updater_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `static_model_lookup_test.go` | port | model registry | |
| `web_search_capability_test.go` | skip | remote catalogs / dropped providers / quota hooks | |
| `web_search_index_test.go` | skip | remote catalogs / dropped providers / quota hooks | |

## `internal/runtime/executor`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `aistudio_executor_test.go` | port | executor for kept provider | |
| `aistudio_issue6258_terminal_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `aistudio_multiframe_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_caqs_replay_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_connection_trace_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_buildrequest_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_compaction_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_credits_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_disable_cooling_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_finish_reason_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_interactions_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_keepalive_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_split_usage_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_terminal_disconnect_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_trailing_reasoning_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_transport_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_executor_unsupported_part_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_home_model_capabilities_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_issue6825_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_issue7000_boundary_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_issue7000_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_preupstream_rewrite_differential_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_preupstream_rewrite_legacy_oracle_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_reasoning_replay_clear_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_reasoning_replay_index_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_reasoning_replay_legacy_oracle_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_reasoning_replay_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_refresh_issue6199_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_refresh_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_schema_sanitize_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `antigravity_transport_decorator_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_bridge_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_capability_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_identity_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_integration_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_repair_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `apply_patch_source_stop_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `caching_verify_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_cloaked_cache_repro_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_cloaked_date_pin_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_effort_directive_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_auth_race_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_auth_test.go` | port | executor for kept provider | |
| `claude_executor_beta_passthrough_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_beta_policy_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_cloaking_display_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_compaction_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_diagnostics_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_fable_ratelimit_test.go` | port | executor for kept provider | |
| `claude_executor_fast_error_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_native_helper_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_ratelimit_test.go` | port | executor for kept provider | |
| `claude_executor_request_bench_test.go` | skip | Go benchmark / race-detector harness | |
| `claude_executor_request_remap_test.go` | port | executor for kept provider | |
| `claude_executor_stop_reasons_test.go` | port | executor for kept provider | |
| `claude_executor_stream_terminal_test.go` | port | executor for kept provider | |
| `claude_executor_stream_truncation_test.go` | port | executor for kept provider | |
| `claude_executor_subagent_ttl_regression_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_test.go` | port | executor for kept provider | |
| `claude_executor_thinking_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_tool_alias_scope_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_tool_search_disabled_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_tool_search_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_web_search_results_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_executor_wire_casing_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_fingerprint_policy_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_header_overrides_issue5093_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_issue7000_regression_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_issue7000_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_issue_6120_test.go` | port | executor for kept provider | |
| `claude_issue_6193_test.go` | port | executor for kept provider | |
| `claude_issue_6698_test.go` | port | executor for kept provider | |
| `claude_messages_passthrough_test.go` | port | executor for kept provider | |
| `claude_mid_system_model_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_prompt_cache_options_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_request_rate_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_signing_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `claude_thinking_replay_test.go` | port | executor for kept provider | |
| `claude_tls_handshake_retry_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_auth_test.go` | port | executor for kept provider | |
| `codex_executor_cache_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_claude_effort_test.go` | port | executor for kept provider | |
| `codex_executor_compact_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_compression_review_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_compression_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_execute_usage_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_grokbuild_keepalive_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_imagegen_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_input_ids_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_instructions_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_parallel_tool_calls_test.go` | port | executor for kept provider | |
| `codex_executor_reasoning_replay_cache_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_retry_test.go` | port | executor for kept provider | |
| `codex_executor_routing_hint_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_search_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_siwc_configuration_update_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_spawn_agent_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_sse_events_test.go` | port | executor for kept provider | |
| `codex_executor_stream_alloc_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_stream_output_test.go` | port | executor for kept provider | |
| `codex_executor_tokens_test.go` | port | executor for kept provider | |
| `codex_executor_tool_schema_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_executor_translate_test.go` | port | executor for kept provider | |
| `codex_native_fidelity_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_openai_images_extract_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_openai_images_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_per_credential_cloaking_issue6034_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_response_model_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_stream_bootstrap_buffering_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_turn_rate_limit_issue7017_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websocket_home_loss_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_active_response_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_connection_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_bootstrap_input_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_credential_failure_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_health_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_initial_failure_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_rejection_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_successor_metadata_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_duplex_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_error_terminal_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_executor_store_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_interrupt_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_late_interrupt_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_late_interrupt_unknown_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_routing_hint_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_spawn_agent_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `codex_websockets_write_loss_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `custom_magic_headers_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `devin_apply_patch_diagnostic_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `devin_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `devin_quota_cooldown_regression_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `devin_stream_content_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `devin_user_turn_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `executor_payload_optimization_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_executor_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_executor_terminal_disconnect_test.go` | port | executor for kept provider | |
| `gemini_executor_test.go` | port | executor for kept provider | |
| `gemini_interactions_continuation_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_interactions_tool_names_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_interactions_translate_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_missing_terminal_upstream_repro_test.go` | port | executor for kept provider | |
| `gemini_vertex_bare_tink_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_interactions_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_openapi_settings_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_openapi_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_terminal_disconnect_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_executor_trailing_reasoning_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `gemini_vertex_interactions_sse_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `home_codex_terminal_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `issue6258_terminal_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `issue6381_responses_eof_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `issue6478_tool_ids_edges_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `issue6478_tool_ids_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `kimi_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `kimi_home_model_capabilities_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `kimi_thinking_replay_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `meta_executor_terminal_disconnect_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `meta_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `meta_executor_ttft_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `oauth_scope_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `openai_compat_executor_compact_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `openai_compat_executor_images_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `openai_compat_executor_max_tokens_test.go` | port | executor for kept provider | |
| `openai_compat_executor_reasoning_test.go` | port | executor for kept provider | |
| `openai_compat_executor_retry_test.go` | port | executor for kept provider | |
| `openai_compat_executor_tool_results_test.go` | port | executor for kept provider | |
| `openai_compat_executor_ttft_test.go` | port | executor for kept provider | |
| `openai_compat_executor_video_test.go` | port | executor for kept provider | |
| `openai_compat_home_options_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `openai_responses_signature_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `payload_barrier_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `payload_review_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `request_proxy_priority_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `response_model_multiprovider_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `unsupported_part_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `vertex_proxy_token_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `websocket_lifecycle_bind_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `websocket_proxy_reuse_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `websocket_session_target_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `websocket_upstream_disconnect_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_client_version_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_configuration_update_plugin_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_configuration_update_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_executor_speech_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_status_err_test.go` | review | executor regression; port only if the kept executor path reproduces it | |
| `xai_websockets_executor_test.go` | review | executor regression; port only if the kept executor path reproduces it | |

## `internal/runtime/executor/helps`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_compaction_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `antigravity_connection_trace_redirect_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `antigravity_connection_trace_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `antigravity_grounding_urls_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `antigravity_interactions_state_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `apply_patch_responses_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `apply_patch_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `cache_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_builtin_tools_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_cli_identity_seed_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_client_detection_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_code_session_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_credential_identity_race_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_credential_identity_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_device_profile_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_diagnostics_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_input_tokens_test.go` | port | executor helper for kept provider | |
| `claude_json_prefilter_fuzz_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_json_prefilter_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_mcp_alias_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_ratelimit_test.go` | port | executor helper for kept provider | |
| `claude_request_rate_test.go` | port | executor helper for kept provider | |
| `claude_tool_search_model_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `claude_upstream_test.go` | port | executor helper for kept provider | |
| `claude_web_search_results_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `codex_input_ids_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `codex_multi_agent_v2_summary_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `codex_multi_agent_v2_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `codex_quota_test.go` | port | executor helper for kept provider | |
| `codex_sse_scanner_test.go` | port | executor helper for kept provider | |
| `codex_terminal_incomplete_test.go` | port | executor helper for kept provider | |
| `codex_tool_schema_batch_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `codex_tool_schema_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `configuration_update_plugin_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `derived_session_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `devin_apply_patch_diagnostic_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `devin_models_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `devin_quota_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `devin_user_turn_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `devin_wire_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `gemini_content_turns_test.go` | port | executor helper for kept provider | |
| `gemini_interactions_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `home_refresh_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `kimi_responses_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `logging_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `meta_tools_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `model_capabilities_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `openai_compat_max_tokens_test.go` | port | executor helper for kept provider | |
| `openai_compat_tool_results_test.go` | port | executor helper for kept provider | |
| `payload_finalizer_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `payload_helpers_codex_integer_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `payload_helpers_disable_image_generation_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `payload_mutations_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `plugin_executor_usage_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `proxy_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `request_pair_compat_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `request_pair_error_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `request_pair_plugin_host_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `request_unsupported_user_turn_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `response_decode_bench_test.go` | skip | Go benchmark / race-detector harness | |
| `response_decode_test.go` | port | executor helper for kept provider | |
| `response_model_multiprovider_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `response_model_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `responses_tool_search_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `responses_ttft_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `responses_usage_helpers_test.go` | port | executor helper for kept provider | |
| `session_id_cache_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `stream_response_model_observer_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `thinking_test.go` | port | executor helper for kept provider | |
| `tool_call_ids_test.go` | port | executor helper for kept provider | |
| `transport_cache_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `transport_decorator_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `unsupported_part_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `usage_helpers_test.go` | port | executor helper for kept provider | |
| `usage_stream_benchmark_test.go` | skip | Go benchmark / race-detector harness | |
| `user_id_cache_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `utls_client_alpn_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `utls_client_handshake_timeout_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `utls_client_resumption_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `utls_client_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `vertex_openapi_settings_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `vertex_openapi_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `vertex_payload_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `websocket_observer_helpers_test.go` | review | executor helper; port only if the kept executor path needs it | |
| `xai_version_test.go` | review | executor helper; port only if the kept executor path needs it | |

## `internal/safemode`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `example_api_keys_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/signature`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `claude_antigravity_boundaries_test.go` | port | thinking signature sanitising used by kept translators | |
| `claude_antigravity_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `claude_messages_sanitize_compat_test.go` | port | thinking signature sanitising used by kept translators | |
| `claude_test.go` | port | thinking signature sanitising used by kept translators | |
| `gemini_sanitize_test.go` | port | thinking signature sanitising used by kept translators | |
| `gemini_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `gpt_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `grok_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `kimi_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `meta_validation_test.go` | port | thinking signature sanitising used by kept translators | |
| `provider_compatibility_test.go` | port | thinking signature sanitising used by kept translators | |

## `internal/store`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `config_seed_test.go` | skip | git/postgres/object stores (Vault + file only) | |
| `disabled_login_save_test.go` | skip | git/postgres/object stores (Vault + file only) | |
| `gitstore_test.go` | skip | git/postgres/object stores (Vault + file only) | |
| `postgres_cooldown_store_test.go` | skip | git/postgres/object stores (Vault + file only) | |

## `internal/thinking`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `apply_codex_usage_test.go` | port | thinking pipeline | |
| `apply_configured_api_key_test.go` | port | thinking pipeline | |
| `claude_enabled_effort_test.go` | port | thinking pipeline | |
| `claude_issue_6698_test.go` | port | thinking pipeline | |
| `claude_standalone_effort_test.go` | port | thinking pipeline | |
| `configuration_update_test.go` | port | thinking pipeline | |
| `kimi_max_clamp_repro_test.go` | skip | Kimi (dropped provider) | |
| `summary_test.go` | port | thinking pipeline | |

## `internal/translator`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `request_benchmark_test.go` | skip | Go benchmark / race-detector harness | |
| `response_benchmark_test.go` | skip | Go benchmark / race-detector harness | |

## `internal/translator/antigravity/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_claude_request_test.go` | skip | dropped provider / API surface | |
| `antigravity_claude_response_test.go` | skip | dropped provider / API surface | |
| `antigravity_claude_user_turn_test.go` | skip | dropped provider / API surface | |
| `signature_validation_test.go` | skip | dropped provider / API surface | |
| `stream_metadata_perf_test.go` | skip | Go benchmark / race-detector harness | |

## `internal/translator/antigravity/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_gemini_request_test.go` | skip | dropped provider / API surface | |
| `antigravity_gemini_response_test.go` | skip | dropped provider / API surface | |
| `noop_optimization_test.go` | skip | dropped provider / API surface | |

## `internal/translator/antigravity/interactions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_antigravity_file_data_test.go` | skip | dropped provider / API surface | |
| `interactions_antigravity_instruction_test.go` | skip | dropped provider / API surface | |
| `interactions_antigravity_test.go` | skip | dropped provider / API surface | |
| `interactions_antigravity_uri_test.go` | skip | dropped provider / API surface | |
| `noop_optimization_test.go` | skip | dropped provider / API surface | |

## `internal/translator/antigravity/openai/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_openai_file_data_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai_media_url_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai_request_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai_response_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai_user_turn_test.go` | skip | dropped provider / API surface | |
| `noop_optimization_test.go` | skip | dropped provider / API surface | |

## `internal/translator/antigravity/openai/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_openai-responses_request_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai-responses_response_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai-responses_tool_search_test.go` | skip | dropped provider / API surface | |
| `antigravity_openai-responses_user_turn_test.go` | skip | dropped provider / API surface | |

## `internal/translator/claude/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `claude_gemini_request_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_gemini_response_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_gemini_user_turn_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `noop_optimization_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |

## `internal/translator/claude/interactions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_claude_instruction_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `interactions_claude_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `interactions_claude_user_turn_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |

## `internal/translator/claude/openai/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `claude_openai_compat_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_file_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_native_response_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_request_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_response_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_stop_reasons_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_user_turn_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `noop_optimization_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |

## `internal/translator/claude/openai/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `claude_openai-responses_citations_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_interleaved_search_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_pause_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_reasoning_order_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_request_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_response_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_server_tool_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_stop_reasons_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_testsupport_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_tool_names_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_tool_search_disabled_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_tool_search_main_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_tool_search_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai-responses_user_turn_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_native_response_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `claude_openai_responses_compat_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |
| `echo_perf_test.go` | skip | Go benchmark / race-detector harness | |
| `noop_optimization_test.go` | skip | OpenAI/Gemini/Interactions inbound -> Claude upstream (inbound endpoints out of scope) | |

## `internal/translator/codex/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `codex_claude_commentary_cross_format_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_commentary_phase_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_commentary_replay_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_compat_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_parallel_function_calls_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_request_benchmark_test.go` | skip | Go benchmark / race-detector harness | |
| `codex_claude_request_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_response_test.go` | port | Claude inbound -> kept upstream translator | |
| `codex_claude_user_turn_test.go` | port | Claude inbound -> kept upstream translator | |
| `noop_optimization_test.go` | port | Claude inbound -> kept upstream translator | |
| `race_disabled_test.go` | skip | Go benchmark / race-detector harness | |
| `race_enabled_test.go` | skip | Go benchmark / race-detector harness | |
| `tool_name_cache_perf_test.go` | skip | Go benchmark / race-detector harness | |

## `internal/translator/codex/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `codex_gemini_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `codex_gemini_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `noop_optimization_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/codex/interactions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_codex_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_codex_uri_test.go` | skip | non-Claude inbound format (out of scope) | |
| `noop_optimization_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/codex/openai/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `codex_openai_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `codex_openai_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `codex_openai_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |
| `noop_optimization_test.go` | skip | non-Claude inbound format (out of scope) | |
| `tool_cache_perf_test.go` | skip | Go benchmark / race-detector harness | |

## `internal/translator/codex/openai/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `codex_openai-responses_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `codex_openai-responses_response_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/common`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_tools_collision_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `antigravity_tools_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `apply_patch_events_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `apply_patch_identity_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `apply_patch_input_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `apply_patch_responses_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `bytes_test.go` | port | shared translator helper | |
| `cache_control_test.go` | port | shared translator helper | |
| `claude_messages_test.go` | port | shared translator helper | |
| `claude_native_response_test.go` | port | shared translator helper | |
| `claude_native_sse_test.go` | port | shared translator helper | |
| `claude_system_test.go` | port | shared translator helper | |
| `claude_user_id_test.go` | port | shared translator helper | |
| `codex_replay_signature_test.go` | port | shared translator helper | |
| `devin_tools_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |
| `file_data_test.go` | port | shared translator helper | |
| `gemini_test.go` | port | shared translator helper | |
| `openai_tools_test.go` | port | shared translator helper | |
| `parts_test.go` | port | shared translator helper | |
| `request_test.go` | port | shared translator helper | |
| `responses_test.go` | port | shared translator helper | |
| `vertex_partial_args_test.go` | skip | helper for dropped provider / Responses-inbound apply_patch bridge | |

## `internal/translator/gemini/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `gemini_claude_compat_test.go` | port | Claude inbound -> kept upstream translator | |
| `gemini_claude_request_test.go` | port | Claude inbound -> kept upstream translator | |
| `gemini_claude_response_test.go` | port | Claude inbound -> kept upstream translator | |
| `gemini_claude_user_turn_test.go` | port | Claude inbound -> kept upstream translator | |

## `internal/translator/gemini/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `gemini_gemini_request_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/gemini/interactions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_gemini_common_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_gemini_file_data_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_gemini_instruction_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_gemini_stream_lines_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_gemini_uri_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_gemini_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/gemini/openai/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `gemini_openai_file_data_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_file_id_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_media_url_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_signature_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |
| `noop_optimization_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/gemini/openai/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `apply_patch_review_test.go` | skip | non-Claude inbound format (out of scope) | |
| `apply_patch_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai-responses_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai-responses_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai-responses_tool_search_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai-responses_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |
| `gemini_openai-responses_web_search_test.go` | skip | non-Claude inbound format (out of scope) | |
| `issue6258_terminal_test.go` | skip | non-Claude inbound format (out of scope) | |
| `noop_optimization_test.go` | skip | non-Claude inbound format (out of scope) | |
| `signature_carrier_test.go` | skip | non-Claude inbound format (out of scope) | |
| `trailing_signature_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/interactions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `import_boundary_test.go` | skip | dropped provider / API surface | |

## `internal/translator/interactions/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_claude_compat_test.go` | skip | dropped provider / API surface | |
| `interactions_claude_test.go` | skip | dropped provider / API surface | |
| `interactions_claude_user_turn_test.go` | skip | dropped provider / API surface | |

## `internal/translator/openai/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `openai_claude_compat_test.go` | port | Claude inbound -> kept upstream translator | |
| `openai_claude_request_test.go` | port | Claude inbound -> kept upstream translator | |
| `openai_claude_response_test.go` | port | Claude inbound -> kept upstream translator | |
| `openai_claude_user_turn_test.go` | port | Claude inbound -> kept upstream translator | |

## `internal/translator/openai/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `openai_gemini_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_gemini_response_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/openai/interactions/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `interactions_openai_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_openai_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_interactions_file_data_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_interactions_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/openai/interactions/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `apply_patch_identity_test.go` | skip | non-Claude inbound format (out of scope) | |
| `apply_patch_rereview_test.go` | skip | non-Claude inbound format (out of scope) | |
| `apply_patch_review_test.go` | skip | non-Claude inbound format (out of scope) | |
| `apply_patch_source_stop_test.go` | skip | non-Claude inbound format (out of scope) | |
| `apply_patch_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_openai_responses_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_openai_responses_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `interactions_openai_responses_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/openai/openai/chat-completions`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `openai_openai_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_openai_response_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/translator/openai/openai/responses`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `custom_tool_namespace_recovery_test.go` | skip | non-Claude inbound format (out of scope) | |
| `echo_perf_test.go` | skip | Go benchmark / race-detector harness | |
| `openai_openai-responses_request_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_openai-responses_response_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_openai-responses_user_turn_test.go` | skip | non-Claude inbound format (out of scope) | |
| `openai_openai-responses_video_test.go` | skip | non-Claude inbound format (out of scope) | |
| `responses_compatibility_digest_test.go` | skip | non-Claude inbound format (out of scope) | |
| `responses_perf_test.go` | skip | Go benchmark / race-detector harness | |
| `responses_request_state_test.go` | skip | non-Claude inbound format (out of scope) | |
| `shell_tool_test.go` | skip | non-Claude inbound format (out of scope) | |

## `internal/tui`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `client_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `oauth_tab_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/util`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `claude_attribution_test.go` | port | schema / tool-id helpers | |
| `claude_model_test.go` | port | schema / tool-id helpers | |
| `claude_schema_test.go` | port | schema / tool-id helpers | |
| `claude_tool_id_test.go` | port | schema / tool-id helpers | |
| `claude_tool_name_perf_test.go` | skip | Go benchmark / race-detector harness | |
| `claude_tool_result_test.go` | port | schema / tool-id helpers | |
| `gemini_schema_ref_test.go` | port | schema / tool-id helpers | |
| `gemini_schema_test.go` | port | schema / tool-id helpers | |
| `github_test.go` | skip | Go-specific or OpenAI-Responses-inbound helper | |
| `gjson_test.go` | skip | Go-specific or OpenAI-Responses-inbound helper | |
| `header_helpers_test.go` | port | schema / tool-id helpers | |
| `nocopy_invariant_test.go` | skip | Go-specific or OpenAI-Responses-inbound helper | |
| `provider_test.go` | port | schema / tool-id helpers | |
| `responses_tools_test.go` | skip | Go-specific or OpenAI-Responses-inbound helper | |
| `sanitize_test.go` | port | schema / tool-id helpers | |
| `sjson_delete_test.go` | skip | Go-specific or OpenAI-Responses-inbound helper | |

## `internal/watcher`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `auth_file_snapshot_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `clients_delete_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `clients_discarded_resend_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `config_reload_ordering_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `dispatcher_snapshot_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `snapshot_traffic_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `watcher_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/watcher/diff`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `config_diff_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cooling_override_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `model_compat_hash_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `model_hash_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `oauth_excluded_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `oauth_model_alias_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `oauth_request_scoped_errors_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `oauth_settings_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_compat_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `vertex_openapi_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/watcher/synthesizer`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `config_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `cooling_override_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `excluded_models_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `file_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `helpers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `stale_snapshot_regression_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `vertex_openapi_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `internal/wsrelay`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `session_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/access`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `registry_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/api/handlers`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `apply_patch_capability_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_decorator_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_error_response_test.go` | port | shared handler plumbing used by the Claude endpoint | |
| `handlers_interceptors_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_metadata_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_model_router_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_plugin_executor_usage_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_request_details_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_speech_only_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_stream_bootstrap_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `handlers_stream_delivery_test.go` | port | shared handler plumbing used by the Claude endpoint | |
| `header_filter_test.go` | port | shared handler plumbing used by the Claude endpoint | |
| `issue7017_retry_after_test.go` | port | shared handler plumbing used by the Claude endpoint | |
| `model_execution_delivery_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `model_execution_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `openai_responses_stream_error_test.go` | skip | plugin / routing / speech / Responses plumbing | |
| `retry_deadline_test.go` | port | shared handler plumbing used by the Claude endpoint | |
| `stream_forwarder_test.go` | port | shared handler plumbing used by the Claude endpoint | |

## `sdk/api/handlers/claude`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `code_handlers_error_test.go` | port | Claude inbound handler | |
| `code_handlers_model_test.go` | port | Claude inbound handler | |

## `sdk/api/handlers/gemini`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `gemini_handlers_stream_error_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `gemini_models_display_name_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `interactions_handlers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/api/handlers/openai`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `codex_client_models_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `codex_client_models_tool_search_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `issue6332_review7_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `issue6332_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_handlers_stream_error_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_handlers_stream_truncation_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_images_handlers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_compact_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_framing_metadata_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_framing_recovery_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_handlers_stream_error_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_handlers_stream_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_late_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_multi_agent_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_plugin_route_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_signature_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_steering_auth_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_steering_error_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_steering_integration_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_steering_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_steering_validation_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_claimed_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_compression_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_disconnect_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_late_local_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_loss_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_metadata_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_requests_memory_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_responses_websocket_unknown_interrupt_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_speech_handlers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_speech_routing_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `openai_videos_handlers_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `permanent_oauth_classification_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `race_disabled_test.go` | skip | Go benchmark / race-detector harness | |
| `race_enabled_test.go` | skip | Go benchmark / race-detector harness | |

## `sdk/auth`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_headless_test.go` | skip | dropped provider | |
| `codex_auth_record_test.go` | port | token store / auth manager | |
| `devin_test.go` | skip | dropped provider | |
| `filestore_codex_refresh_test.go` | port | token store / auth manager | |
| `filestore_disabled_test.go` | port | token store / auth manager | |
| `filestore_proxy_test.go` | port | token store / auth manager | |
| `filestore_test.go` | port | token store / auth manager | |
| `manager_test.go` | port | token store / auth manager | |
| `meta_test.go` | skip | dropped provider | |
| `refresh_registry_test.go` | port | token store / auth manager | |
| `xai_test.go` | skip | dropped provider | |

## `sdk/cliproxy`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_model_probes_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_backoff_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_dedup_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_fencing_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_lifecycle_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_publication_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_queue_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_refresh_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_registration_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_review_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_timeout_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `antigravity_models_version_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `builder_weight_validation_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `config_model_display_name_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `config_model_max_context_length_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `discovery_advertiser_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `home_plugins_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `model_registration_config_fence_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `model_registration_issue6718_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `model_registration_plugin_exclusion_fence_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `model_registration_publication_regression_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `openai_compat_config_models_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `plugin_static_model_exclusions_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `pprof_server_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `rtprovider_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_auth_sync_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_batch_model_registration_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_catalogs_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_codex_executor_binding_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_codex_models_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_config_weight_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_cooldown_store_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_excluded_models_priority_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_excluded_models_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_executionregistry_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_executor_registration_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_home_cancellation_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_home_rebalance_finalization_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_home_rebalance_release_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_home_rebalance_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_home_retry_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_management_save_reload_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_models_config_index_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_oauth_model_alias_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_oauth_settings_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_openai_compat_race_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_plugin_executor_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_plugin_refresh_executor_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_plugin_scheduler_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_result_policy_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_run_startup_race_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_snapshot_runtime_state_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_stale_state_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_stop_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_vertex_openapi_capabilities_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `service_vertex_openapi_models_test.go` | skip | service wiring / plugins / Home / antigravity | |

## `sdk/cliproxy/auth`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `antigravity_credits_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `api_key_model_alias_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `api_key_model_capabilities_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `api_key_model_compat_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `apply_patch_capability_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `auth_change_watch_test.go` | port | round-robin / cooldown / failover core | |
| `auto_refresh_issue6199_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `auto_refresh_loop_test.go` | port | round-robin / cooldown / failover core | |
| `catalog_credential_quota_regression_test.go` | port | round-robin / cooldown / failover core | |
| `classification_test.go` | port | round-robin / cooldown / failover core | |
| `claude_ratelimit_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `codex_forcemap_ws_forward_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `codex_model_not_found_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `codex_siwc_bind_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_alias_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_availability_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_cancellation_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_claude_cancellation_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_cloudflare_520_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_compact_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_cooldown_monotonic_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_cooling_precedence_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_credits_candidates_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_execution_error_priority_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_execution_quota_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_executor_replace_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_fast_error_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_force_mapping_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_issue6415_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6416_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6417_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6503_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6643_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6742_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6819_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue6865_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_execution_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_review_r1_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_review_r3_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_review_r4_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_review_r5_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_review_r6_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7017_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_issue7056_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_lifecycle_race_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_load_persistence_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_oauth_alias_nofork_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_oauth_alias_suspension_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_oauth_request_scoped_errors_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_overrides_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_persist_failure_logging_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_quota_clock_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_recent_requests_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_refresh_disabled_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_refresh_executor_key_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_remove_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_request_scoped_errors_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_result_policy_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_retry_round_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_saved_fields_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_scheduler_cooldown_rebuild_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_scheduler_refresh_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_scheduler_targeted_update_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_selection_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_session_affinity_alias_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_speech_format_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_stream_overload_failover_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_stream_overload_status_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_stream_quota_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_subsecond_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_transport_retry_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_unauthorized_refresh_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_update_test.go` | port | round-robin / cooldown / failover core | |
| `conductor_usage_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_warn_logging_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `conductor_weight_validation_test.go` | port | round-robin / cooldown / failover core | |
| `config_apikey_test.go` | port | round-robin / cooldown / failover core | |
| `connection_lifecycle_cooldown_test.go` | port | round-robin / cooldown / failover core | |
| `cooldown_backoff_test.go` | port | round-robin / cooldown / failover core | |
| `cooldown_state_test.go` | port | round-robin / cooldown / failover core | |
| `cooldown_view_test.go` | port | round-robin / cooldown / failover core | |
| `custom_headers_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `devin_quota_refresh_regression_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `error_events_test.go` | port | round-robin / cooldown / failover core | |
| `errors_compat_test.go` | port | round-robin / cooldown / failover core | |
| `file_snapshot_cooldown_seq_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `file_snapshot_traffic_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `force_mapping_live_fixtures_test.go` | port | round-robin / cooldown / failover core | |
| `force_refresh_test.go` | port | round-robin / cooldown / failover core | |
| `home_availability_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_concurrency_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_configuration_update_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_dispatch_headers_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_execution_paths_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_fallback_audit_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_force_mapping_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_in_flight_publisher_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_retry_contract_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_retry_loop_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_selected_auth_callback_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_selection_attempt_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_selection_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_session_alias_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_unauthorized_refresh_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_v8_model_capabilities_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_web_search_capability_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `home_websocket_reuse_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `meta_refresh_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `metadata_keys_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `metadata_merge_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `native_tool_search_capability_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `oauth_model_alias_test.go` | port | round-robin / cooldown / failover core | |
| `openai_compat_pool_test.go` | port | round-robin / cooldown / failover core | |
| `persist_policy_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `priority_test.go` | port | round-robin / cooldown / failover core | |
| `quota_signals_test.go` | port | round-robin / cooldown / failover core | |
| `request_auth_prepare_test.go` | port | round-robin / cooldown / failover core | |
| `request_proxy_refresh_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `request_termination_test.go` | port | round-robin / cooldown / failover core | |
| `response_model_rewriter_antigravity_sim_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `response_model_rewriter_test.go` | port | round-robin / cooldown / failover core | |
| `retry_deadline_test.go` | port | round-robin / cooldown / failover core | |
| `scheduler_benchmark_test.go` | skip | Go benchmark / race-detector harness | |
| `scheduler_test.go` | port | round-robin / cooldown / failover core | |
| `selected_auth_metadata_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `selector_antigravity_subagent_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `selector_guardian_affinity_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `selector_lcp_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `selector_subagent_affinity_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `selector_test.go` | port | round-robin / cooldown / failover core | |
| `session_affinity_lookup_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `session_affinity_metadata_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `session_affinity_priority_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `session_cache_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `session_overhead_benchmark_test.go` | skip | Go benchmark / race-detector harness | |
| `trusted_retry_after_test.go` | port | round-robin / cooldown / failover core | |
| `types_cooling_test.go` | port | round-robin / cooldown / failover core | |
| `types_test.go` | port | round-robin / cooldown / failover core | |
| `vertex_openapi_capabilities_test.go` | skip | Home/plugin/session-affinity/dropped-provider or upstream issue regression | |
| `weight_test.go` | port | round-robin / cooldown / failover core | |

## `sdk/cliproxy/executionregistry`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `concurrency_release_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `observation_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `registry_test.go` | skip | service wiring / plugins / Home / antigravity | |

## `sdk/cliproxy/executor`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `lifecycle_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `tls_handshake_timeout_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `types_test.go` | port | executor option helpers | |
| `websocket_test.go` | skip | service wiring / plugins / Home / antigravity | |

## `sdk/cliproxy/session`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `identity_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `info_duplicate_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `info_performance_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `info_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `lcp_lookup_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `lcp_test.go` | skip | service wiring / plugins / Home / antigravity | |

## `sdk/cliproxy/usage`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `accounting_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `manager_test.go` | skip | service wiring / plugins / Home / antigravity | |
| `stream_delivery_test.go` | skip | service wiring / plugins / Home / antigravity | |

## `sdk/httptransport`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `decorator_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/pluginabi`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `types_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/pluginapi`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `types_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/pluginhost`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `host_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `quota_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `thinking_disable_type_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/pluginstore`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `network_scope_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |
| `pluginstore_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/proxyutil`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `proxy_test.go` | skip | infrastructure not carried over (plugins, watcher, TUI, Home, logging, misc) | |

## `sdk/translator`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `registry_bytes_test.go` | port | translator registry | |
| `registry_summary_test.go` | port | translator registry | |
| `registry_test.go` | port | translator registry | |

## `test`

| Go test | Disposition | Reason | Ported as |
|---|---|---|---|
| `builtin_tools_translation_test.go` | port | cross-module integration test | |
| `claude_code_compatibility_sentinel_test.go` | port | cross-module integration test | |
| `codex_claude_parallel_function_calls_test.go` | port | cross-module integration test | |
| `codex_incomplete_stream_error_type_test.go` | port | cross-module integration test | |
| `codex_quota_failover_test.go` | port | cross-module integration test | |
| `codex_stream_disconnect_failover_test.go` | port | cross-module integration test | |
| `gemini_ref_sibling_test.go` | port | cross-module integration test | |
| `summary_intent_translation_test.go` | port | cross-module integration test | |
| `thinking_conversion_test.go` | port | cross-module integration test | |
| `usage_logging_test.go` | port | cross-module integration test | |

