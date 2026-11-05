CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,document TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS mutes(rule_id TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(rule_id,scope_id));

CREATE TABLE IF NOT EXISTS classifications(project_id TEXT PRIMARY KEY,classification TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS observations(thread_id TEXT PRIMARY KEY,hash TEXT NOT NULL,observed_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS episodes(thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,rule_id));

CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,rule_id TEXT NOT NULL,run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,
        dispatch_started INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,document TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY,tokens INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS activity_notice ON activity(json_extract(document,'$.noticeId'),created_at);

INSERT OR IGNORE INTO meta VALUES('settings','{"generation":1,"evidenceHours":24}');

ALTER TABLE episodes ADD COLUMN object_id TEXT;

ALTER TABLE notices ADD COLUMN rule_generation INTEGER NOT NULL DEFAULT -1;

ALTER TABLE notices ADD COLUMN settings_generation INTEGER NOT NULL DEFAULT -1;

CREATE TABLE IF NOT EXISTS supervisor_owned_threads(id TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id));

CREATE TABLE IF NOT EXISTS supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root));

CREATE TABLE IF NOT EXISTS supervisor_chat_enables(thread_id TEXT PRIMARY KEY,enabled_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS supervisor_tasks_project ON supervisor_task_interpretations(project_id);

INSERT INTO meta VALUES('supervisor_scope_version','main-v1');

CREATE TABLE IF NOT EXISTS supervisor_planning_attempts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS supervisor_planning_project ON supervisor_planning_attempts(project_id);

CREATE TABLE IF NOT EXISTS supervisor_conversation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS supervisor_conversation_project ON supervisor_conversation_requests(project_id);

CREATE TABLE IF NOT EXISTS supervisor_workflow_introductions(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS supervisor_workflow_agreement_candidates(task_id TEXT NOT NULL,proposal_id TEXT NOT NULL,project_id TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(task_id,proposal_id));

CREATE INDEX IF NOT EXISTS supervisor_workflow_agreement_project ON supervisor_workflow_agreement_candidates(project_id);

CREATE TABLE IF NOT EXISTS supervisor_monitor_binding_clock(supervisor_thread_id TEXT PRIMARY KEY,last_notice_at INTEGER NOT NULL,review_misses INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS supervisor_monitor_threads(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_ordinal INTEGER NOT NULL,
        activation_ordinal INTEGER NOT NULL,
        saturated INTEGER NOT NULL DEFAULT 0,
        saturation_at INTEGER,
        last_acknowledged_at INTEGER,
        untracked_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, thread_id)
      );

CREATE TABLE IF NOT EXISTS supervisor_monitor_items(
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        read_item_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        detected_at INTEGER NOT NULL,
        version TEXT NOT NULL,
        priority TEXT,
        eligible INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        reviewed_version TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, thread_id, item_id)
      );

CREATE INDEX IF NOT EXISTS supervisor_monitor_pending
        ON supervisor_monitor_items(project_id, thread_id, eligible, reviewed_version);

CREATE INDEX IF NOT EXISTS supervisor_main_binding_thread ON supervisor_main_bindings(json_extract(document,'$.threadId'));

CREATE TABLE IF NOT EXISTS supervisor_team_members(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,member_thread_id TEXT NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,member_thread_id));

CREATE UNIQUE INDEX IF NOT EXISTS supervisor_team_member_identity ON supervisor_team_members(member_thread_id) WHERE state<>'retired';

CREATE TABLE IF NOT EXISTS supervisor_team_assignments(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,subtree_root_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,subtree_root_thread_id));

CREATE TABLE IF NOT EXISTS supervisor_team_notifications(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,recipient_thread_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id));

CREATE INDEX IF NOT EXISTS supervisor_team_notifications_recipient ON supervisor_team_notifications(owner_thread_id,owner_generation,recipient_thread_id,state,created_at);

CREATE TABLE IF NOT EXISTS supervisor_team_events(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,id TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,id));

CREATE INDEX IF NOT EXISTS supervisor_team_events_pending ON supervisor_team_events(owner_thread_id,owner_generation,acknowledged_at,created_at);

CREATE TABLE IF NOT EXISTS supervisor_team_requests(owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(owner_thread_id,owner_generation,request_id));

CREATE INDEX IF NOT EXISTS supervisor_team_requests_pending ON supervisor_team_requests(owner_thread_id,owner_generation,state,created_at);

CREATE TABLE IF NOT EXISTS supervisor_workflow_state (workflow_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,thread_id TEXT NOT NULL,parent_workflow_id TEXT,parent_thread_id TEXT,revision INTEGER NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,main_thread_id,thread_id));

CREATE INDEX IF NOT EXISTS supervisor_workflow_scope ON supervisor_workflow_state(project_id,main_thread_id);

CREATE TABLE IF NOT EXISTS supervisor_workflow_operations (project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,operation_namespace TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,workflow_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project_id,main_thread_id,actor_thread_id,binding_generation,operation_namespace,operation_id));

CREATE TABLE IF NOT EXISTS supervisor_helper_channels(
      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,helper_thread_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,owner_generation,helper_thread_id));

CREATE TABLE IF NOT EXISTS supervisor_helper_deliveries(
      owner_thread_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,message_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,owner_generation,message_id));

CREATE TABLE IF NOT EXISTS supervisor_workflow_write_receipts (
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        supervisor_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id)
      );

CREATE TABLE IF NOT EXISTS supervisor_workflow_write_evidence (
        supervisor_thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        native_evidence TEXT NOT NULL,
        result TEXT NOT NULL,
        successful INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(supervisor_thread_id,item_id)
      );

CREATE INDEX IF NOT EXISTS supervisor_workflow_write_evidence_operation
        ON supervisor_workflow_write_evidence(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id,created_at);

CREATE TABLE IF NOT EXISTS supervisor_team_tool_receipts(
      owner_thread_id TEXT NOT NULL,actor_thread_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,actor_epoch INTEGER NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,evidence_item_id TEXT NOT NULL,document TEXT NOT NULL,
      PRIMARY KEY(owner_thread_id,actor_thread_id,binding_generation,actor_epoch,operation_id));

CREATE TABLE IF NOT EXISTS supervisor_workflow_write_receipts (
        operation_id TEXT NOT NULL,
        operation_namespace TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        project_id TEXT NOT NULL,
        main_thread_id TEXT NOT NULL,
        supervisor_thread_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id,main_thread_id,supervisor_thread_id,binding_generation,operation_namespace,operation_id)
      );
