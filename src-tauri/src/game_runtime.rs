//! Version routing for native gameplay. Formatting and persistence stay in the
//! version-specific core; the same transport exposes both without rewriting v1.

use std::path::Path;

use lishi_core::{
    game_inspection::inspect_world,
    game_knowledge::ValidatedHistory,
    game_protocol::{self, WorldSetup, WorldState},
    game_protocol_v2::{self, CommitContext, WorldStateV2},
    game_provider, game_provider_v2,
    game_store::{
        GameOperation, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest, WorldView,
    },
    game_store_v2::{GameStoreV2, WorldViewV2},
};
use serde::Serialize;

use super::GameCommandError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WorldReply {
    V1(Box<WorldView>),
    V2(Box<WorldViewV2>),
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum StateReply<'a> {
    V1(&'a WorldState),
    V2(&'a WorldStateV2),
}

impl WorldReply {
    pub fn setup(&self) -> &WorldSetup {
        match self {
            Self::V1(view) => &view.setup,
            Self::V2(view) => &view.setup,
        }
    }
    pub fn head_turn_id(&self) -> Option<&str> {
        match self {
            Self::V1(view) => view.head_turn_id.as_deref(),
            Self::V2(view) => view.head_turn_id.as_deref(),
        }
    }
    pub fn turn_count(&self) -> u64 {
        match self {
            Self::V1(view) => view.turn_count,
            Self::V2(view) => view.turn_count,
        }
    }
    pub fn latest_operation(&self) -> Option<&GameOperation> {
        match self {
            Self::V1(view) => view.latest_operation.as_ref(),
            Self::V2(view) => view.latest_operation.as_ref(),
        }
    }
    pub fn state(&self) -> StateReply<'_> {
        match self {
            Self::V1(view) => StateReply::V1(&view.state),
            Self::V2(view) => StateReply::V2(&view.state),
        }
    }
    pub fn protagonist_dead(&self) -> bool {
        match self.state() {
            StateReply::V1(state) => state
                .entities
                .iter()
                .any(|e| e.id == state.protagonist_id && e.alive == Some(false)),
            StateReply::V2(state) => state
                .entities
                .iter()
                .any(|e| e.id == state.protagonist_id && e.alive == Some(false)),
        }
    }
}

pub enum StoreRoute {
    V1(GameStore),
    V2(GameStoreV2),
}
pub enum OutputRoute {
    V1(game_protocol::TurnOutput),
    V2(game_protocol_v2::TurnOutputV2),
}
impl OutputRoute {
    pub fn narrative(&self) -> &str {
        match self {
            Self::V1(output) => &output.narrative,
            Self::V2(output) => &output.narrative,
        }
    }
    pub fn json(&self) -> Result<String, GameCommandError> {
        match self {
            Self::V1(output) => serde_json::to_string(output),
            Self::V2(output) => serde_json::to_string(output),
        }
        .map_err(|_| GameCommandError::new("game_invalid_output"))
    }
    pub fn validate_against(&self, view: &WorldReply, id: &str) -> Result<(), GameCommandError> {
        match (self, view) {
            (Self::V1(output), WorldReply::V1(view)) => {
                game_protocol::apply_output(&view.state, output)?;
            }
            (Self::V2(output), WorldReply::V2(view)) => {
                game_protocol_v2::apply_output_v2(
                    &view.state,
                    output,
                    &CommitContext {
                        operation_id: id.into(),
                        turn_id: id.into(),
                    },
                )?;
            }
            _ => return Err(GameCommandError::new("game_invalid_protocol")),
        }
        Ok(())
    }
}

impl StoreRoute {
    pub fn open_existing(path: &Path) -> Result<Self, GameCommandError> {
        match inspect_world(path)
            .map_err(|e| GameCommandError::new(e.to_string()))?
            .schema_version
        {
            1 => Ok(Self::V1(GameStore::open(path)?)),
            2 => Ok(Self::V2(GameStoreV2::open(path)?)),
            _ => Err(GameCommandError::new("game_incompatible_schema")),
        }
    }
    pub fn open_new(path: &Path) -> Result<Self, GameCommandError> {
        Ok(Self::V2(GameStoreV2::open(path)?))
    }
    pub fn view(&self) -> Result<WorldReply, GameCommandError> {
        Ok(match self {
            Self::V1(store) => WorldReply::V1(Box::new(store.view()?)),
            Self::V2(store) => WorldReply::V2(Box::new(store.view()?)),
        })
    }
    pub fn create_world(&self, setup: &WorldSetup) -> Result<WorldReply, GameCommandError> {
        let opening = game_provider::opening_narrative(setup);
        let choices = game_provider::initial_choices();
        Ok(match self {
            Self::V1(store) => WorldReply::V1(Box::new(store.create_world(
                setup,
                &game_protocol::initial_state(setup)?,
                &opening,
                &choices,
            )?)),
            Self::V2(store) => WorldReply::V2(Box::new(store.create_world_v2(
                setup,
                &game_protocol_v2::initial_state_v2(setup)?,
                &opening,
                &choices,
            )?)),
        })
    }
    pub fn begin(&self, request: &GameTurnRequest) -> Result<(), GameCommandError> {
        match self {
            Self::V1(s) => s.begin(request)?,
            Self::V2(s) => s.begin(request)?,
        };
        Ok(())
    }
    pub fn mark_generating(&self, id: &str) -> Result<(), GameCommandError> {
        match self {
            Self::V1(s) => s.mark_generating(id)?,
            Self::V2(s) => s.mark_generating(id)?,
        };
        Ok(())
    }
    pub fn stage_output(&self, id: &str, raw: &str) -> Result<(), GameCommandError> {
        match self {
            Self::V1(s) => s.stage_output(id, raw)?,
            Self::V2(s) => s.stage_output(id, raw)?,
        };
        Ok(())
    }
    pub fn finish_uncommitted(
        &self,
        id: &str,
        status: GameOperationStatus,
        code: Option<&str>,
    ) -> Result<(), GameCommandError> {
        match self {
            Self::V1(s) => s.finish_uncommitted(id, status, code)?,
            Self::V2(s) => s.finish_uncommitted(id, status, code)?,
        };
        Ok(())
    }
    pub fn update_policy(&self, policy: &str) -> Result<(), GameCommandError> {
        match self {
            Self::V1(s) => {
                s.update_policy(policy)?;
            }
            Self::V2(s) => {
                s.update_policy(policy)?;
            }
        };
        Ok(())
    }
    pub fn demo_output(
        view: &WorldReply,
        request: &GameTurnRequest,
    ) -> Result<OutputRoute, GameCommandError> {
        Ok(match view {
            WorldReply::V1(v) => OutputRoute::V1(game_provider::demo_output(&v.state, request)?),
            WorldReply::V2(v) => {
                OutputRoute::V2(game_provider_v2::demo_output_v2(&v.state, request)?)
            }
        })
    }
    pub fn parse_output(view: &WorldReply, raw: &str) -> Result<OutputRoute, GameCommandError> {
        Ok(match view {
            WorldReply::V1(_) => OutputRoute::V1(game_protocol::parse_output(raw)?),
            WorldReply::V2(_) => OutputRoute::V2(game_protocol_v2::parse_output_v2(raw)?),
        })
    }
    pub fn knowledge_history(&self) -> Result<ValidatedHistory, GameCommandError> {
        match self {
            Self::V2(s) => Ok(s.knowledge_history()?),
            Self::V1(_) => Err(GameCommandError::new("game_invalid_protocol")),
        }
    }
    pub fn commit_with_hook<F: FnOnce() -> Result<(), GameStoreError>>(
        &self,
        id: &str,
        output: &OutputRoute,
        hook: F,
    ) -> Result<WorldReply, GameCommandError> {
        Ok(match (self, output) {
            (Self::V1(s), OutputRoute::V1(o)) => {
                WorldReply::V1(Box::new(s.commit_with_hook(id, o, hook)?))
            }
            (Self::V2(s), OutputRoute::V2(o)) => {
                WorldReply::V2(Box::new(s.commit_with_hook(id, o, hook)?))
            }
            _ => return Err(GameCommandError::new("game_invalid_protocol")),
        })
    }
}
