use super::{
    clean_name, has_role, message_preview, message_text, reply, turn_id, AgentTurn, Conversation,
    Gate, Handling, State, Titling, ANSWERED_PREFIX, DIALOGS, HIDDEN_UI, HOST_PREFIX, STATE_PREFIX,
    STDERR_LIMIT, TITLE_PREFIX,
};
use serde_json::Value;

impl State {
    pub(super) fn forward(&mut self, line: String) {
        if let Some(subscriber) = &self.subscriber {
            if subscriber.send(line).is_err() {
                self.subscriber = None;
            }
        }
    }
    pub(super) fn append_stderr(&mut self, text: &str) {
        self.stderr.push_str(text);
        if self.stderr.len() > STDERR_LIMIT {
            let mut start = self.stderr.len() - STDERR_LIMIT;
            while !self.stderr.is_char_boundary(start) {
                start += 1;
            }
            self.stderr.drain(..start);
        }
    }
    pub(super) fn exit_record(&self) -> String {
        serde_json::json!({
            "type": "soreno_exited",
            "exitCode": self.exit_code,
            "stderr": self.stderr,
        })
        .to_string()
    }
    pub(super) fn next_id(&mut self, prefix: &str) -> String {
        self.requests += 1;
        format!("{prefix}{}", self.requests)
    }

    /// `replayed`: dtach output from before this client, seen by a previous one or by none.
    pub(super) fn handle(&mut self, record: &Value, line: &str, replayed: bool) -> Handling {
        let field = |key| record.get(key).and_then(Value::as_str);
        let succeeded = record.get("success") == Some(&Value::Bool(true));
        let mut handling = Handling {
            forward: true,
            refresh: false,
            rename: false,
        };
        if replayed {
            // Only what still holds counts: the previous client already titled and refreshed,
            // and the responses answered its own requests.
            let holds = match field("type").unwrap_or_default() {
                "response" => field("id").is_some_and(|id| id.starts_with(ANSWERED_PREFIX)),
                kind => matches!(
                    kind,
                    "agent_start"
                        | "session_settled"
                        | "prompt_result"
                        | "message_end"
                        | "agent_end"
                        | "extension_ui_request"
                ),
            };
            if holds {
                self.handle(record, line, false);
            }
            return Handling {
                forward: false,
                refresh: false,
                rename: false,
            };
        }
        match field("type").unwrap_or_default() {
            "ready" => {
                handling.forward = false;
                if self.gate == Gate::Ready {
                    self.gate = Gate::Opening;
                }
            }
            "response" if field("id").is_some_and(|id| id.starts_with(HOST_PREFIX)) => {
                handling.forward = false;
                let id = field("id").unwrap_or_default();
                if id.starts_with(STATE_PREFIX) {
                    if let Some(data) = record.get("data").filter(|_| succeeded) {
                        self.identify(data);
                        // Exact even when the run started before this client.
                        if let Some(settled) = data.get("isSettled").and_then(Value::as_bool) {
                            self.working = !settled;
                        }
                    }
                } else if let Some(dialog) = id.strip_prefix(ANSWERED_PREFIX) {
                    self.dialogs.retain(|(id, _)| id != dialog);
                } else if id.starts_with(TITLE_PREFIX) {
                    // shortcut: an OMP without `/rename` gets one per conversation; remember it per run if needed.
                    if record.pointer("/data/agentInvoked") != Some(&Value::Bool(false)) {
                        self.renaming = false;
                        self.titling = Titling::Off;
                    }
                } else if let Some(waiting) = self.acknowledgements.remove(id) {
                    let _ = waiting.send(if succeeded {
                        Ok(())
                    } else {
                        Err(format!(
                            "OMP a refusé le message : {}",
                            field("error").unwrap_or("raison inconnue")
                        ))
                    });
                }
            }
            "response" => {
                handling.refresh = succeeded
                    && matches!(
                        field("command"),
                        Some("new_session" | "switch_session" | "set_session_name")
                    );
                // An active goal starts its turn with a hidden message instead of a user one.
                // shortcut: a read-only `/goal show` on an active goal also counts, titling an untitled conversation early; track the sent op if it matters.
                if succeeded
                    && field("command") == Some("goal")
                    && record.pointer("/data/goal/status") == Some(&Value::from("active"))
                {
                    let objective = record
                        .pointer("/data/goal/objective")
                        .and_then(Value::as_str);
                    self.user_message(objective.map(str::to_owned));
                }
            }
            "agent_start" => self.working = true,
            "session_settled" => {
                self.working = false;
                // An abort dismisses pending dialogs without a record of its own.
                self.dialogs.clear();
                handling.refresh = true;
            }
            "prompt_result" => {
                if record.get("sessionSettled") == Some(&Value::Bool(true)) {
                    self.working = false;
                }
            }
            "session_info_update" => {
                handling.refresh = true;
                if self.renaming {
                    self.titling = Titling::Generated;
                }
            }
            // shortcut: a user command's output landing first is hidden instead; fix if OMP tags it.
            "command_output" if self.renaming => {
                self.renaming = false;
                handling.forward = false;
            }
            "message_start" => {
                let message = record.get("message").unwrap_or(&Value::Null);
                if has_role(message, "user") {
                    self.user_message(message_text(message));
                } else if has_role(message, "assistant") && std::mem::take(&mut self.title_pending)
                {
                    handling.rename = self.start_renaming();
                }
            }
            "tool_execution_end"
                if self.titling == Titling::Generated
                    && field("toolName") == Some("todo")
                    && record.get("isError") != Some(&Value::Bool(true))
                    && record.pointer("/result/details/op") == Some(&Value::from("init")) =>
            {
                handling.rename = self.start_renaming();
            }
            "message_end" => {
                let message = record.get("message").unwrap_or(&Value::Null);
                if has_role(message, "assistant") {
                    self.last_assistant = reply(message);
                }
            }
            "agent_end"
                if record.get("yielded") != Some(&Value::Bool(false))
                    && record.get("willContinue") != Some(&Value::Bool(true))
                    && record.get("isTerminal") != Some(&Value::Bool(false)) =>
            {
                let last = record
                    .get("messages")
                    .and_then(Value::as_array)
                    .and_then(|messages| {
                        messages
                            .iter()
                            .rev()
                            .find(|message| has_role(message, "assistant"))
                    })
                    .and_then(reply)
                    .or_else(|| self.last_assistant.take());
                self.last_message = last.as_ref().and_then(|(text, _)| message_preview(text));
                self.turn = last.map(|(text, timestamp)| AgentTurn {
                    id: turn_id(&timestamp, &text),
                    message: Some(text),
                });
            }
            "extension_ui_request" => match field("method") {
                Some(method) if HIDDEN_UI.contains(&method) => handling.forward = false,
                Some("cancel") => {
                    if let Some(target) = field("targetId") {
                        self.dialogs.retain(|(id, _)| id != target);
                    }
                }
                Some(method) if DIALOGS.contains(&method) => {
                    if let Some(id) = field("id") {
                        self.dialogs.push((id.to_owned(), line.to_owned()));
                    }
                }
                _ => {}
            },
            _ => {}
        }
        handling
    }

    fn user_message(&mut self, text: Option<String>) {
        self.title_pending |= self.titling == Titling::Untitled;
        if self.first_message.is_none() {
            self.first_message = text.as_deref().and_then(clean_name);
            if let Some(conversation) = &mut self.conversation {
                if conversation.name.is_none() {
                    conversation.name = self.first_message.clone();
                }
            }
        }
    }

    /// Whether to send Soreno's `/rename`: one at a time.
    fn start_renaming(&mut self) -> bool {
        !std::mem::replace(&mut self.renaming, true)
    }

    /// A command the view sends: a name the user gives stops Soreno titling the conversation.
    pub(super) fn sent(&mut self, kind: &str, message: Option<&str>) {
        if kind == "set_session_name"
            || message
                .filter(|_| kind == "prompt")
                .is_some_and(|message| message.split_whitespace().next() == Some("/rename"))
        {
            self.titling = Titling::Off;
            self.title_pending = false;
            self.renaming = false;
        }
    }

    pub(super) fn resume(&mut self, path: &str) {
        self.resuming = self
            .titles
            .get(path)
            .map(|title| (path.to_owned(), title.clone()));
    }

    /// Applies a `get_state` result; another conversation starts unnamed, unless it is the
    /// listed history being resumed.
    fn identify(&mut self, data: &Value) {
        let Some(session_id) = data.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let same = self
            .conversation
            .as_ref()
            .is_none_or(|conversation| conversation.session_id == session_id);
        let known_name = match &self.conversation {
            Some(conversation) if same => conversation.name.clone(),
            _ => None,
        };
        if !same {
            let file = data.get("sessionFile").and_then(Value::as_str);
            self.first_message = self
                .resuming
                .take()
                .filter(|(path, _)| file == Some(path.as_str()))
                .map(|(_, title)| title);
        }
        let named = data
            .get("sessionName")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty());
        if !same || self.titling == Titling::Unknown {
            self.titling = if named {
                Titling::Off
            } else {
                Titling::Untitled
            };
            self.title_pending = false;
            self.renaming = false;
        } else if named && self.titling == Titling::Untitled {
            self.titling = Titling::Off;
        }
        let text = |key| data.get(key).and_then(Value::as_str).map(str::to_owned);
        let conversation = Conversation {
            session_id: session_id.to_owned(),
            session_file: text("sessionFile"),
            name: text("sessionName")
                .or(known_name)
                .or_else(|| self.first_message.clone()),
        };
        if let Some(conversation) = conversation.validated() {
            self.conversation = Some(conversation);
        }
    }
}
