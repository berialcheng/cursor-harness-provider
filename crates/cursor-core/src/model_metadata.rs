//! AvailableModels wire metadata, decoded in the shared pure Rust core.
//! Field numbers follow vendor/pi-cursor/src/client/cursor-wire.ts (MIT).
//! Only returned variants are exposed; no Cartesian products or inferred modes.

use std::collections::HashSet;

use anyhow::{ensure, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use super::{read_varint, validate_fields, wire_fields_bounded, WireBudget, WireField};
use crate::types::{validate_model_parameters, ModelParameter, MAX_MODEL_PARAMETERS};

const MAX_MODELS: usize = 4096;
const MAX_VARIANTS: usize = 2048;
const MAX_NAME_BYTES: usize = 512;
const MAX_DISPLAY_BYTES: usize = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParameterizedVariant {
    parameters: Vec<ModelParameter>,
    is_max_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_default_max_config: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_default_non_max_config: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name_outside_picker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant_string_representation: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParameterizedModel {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_model_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_max_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_non_max_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    supports_images: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_token_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_token_limit_for_max_mode: Option<u32>,
    variants: Vec<ParameterizedVariant>,
}

fn string(fields: &[WireField<'_>], number: u32, limit: usize) -> Result<Option<String>> {
    fields
        .iter()
        .find(|f| f.number == number)
        .map(|field| {
            ensure!(
                field.data.len() <= limit,
                "Cursor model metadata string is too large"
            );
            let value =
                std::str::from_utf8(field.data).context("Invalid Cursor model metadata UTF-8")?;
            ensure!(
                !value.chars().any(char::is_control),
                "Invalid Cursor model metadata string"
            );
            Ok(value.to_owned())
        })
        .transpose()
}

fn integer(fields: &[WireField<'_>], number: u32) -> Result<Option<u64>> {
    fields
        .iter()
        .find(|f| f.number == number)
        .map(|f| read_varint(f.data, &mut 0))
        .transpose()
}

fn boolean(fields: &[WireField<'_>], number: u32) -> Result<Option<bool>> {
    integer(fields, number)?
        .map(|value| {
            ensure!(value <= 1, "Invalid Cursor model metadata boolean");
            Ok(value == 1)
        })
        .transpose()
}

fn context_limit(fields: &[WireField<'_>], number: u32) -> Result<Option<u32>> {
    integer(fields, number)?
        .map(|value| {
            let limit = u32::try_from(value).context("Cursor model context limit is too large")?;
            ensure!(limit > 0, "Cursor model context limit is zero");
            Ok(limit)
        })
        .transpose()
}

fn parameter(bytes: &[u8], budget: &mut WireBudget) -> Result<ModelParameter> {
    let fields = wire_fields_bounded(bytes, budget)?;
    validate_fields(&fields, &[(1, 2), (2, 2)], &[], true)?;
    Ok(ModelParameter {
        id: string(&fields, 1, MAX_NAME_BYTES)?.context("Cursor model parameter id is missing")?,
        // Proto3 omits default scalars: absent and explicit empty are the same
        // legitimate opaque value, as in the pinned reference decoder.
        value: string(&fields, 2, MAX_DISPLAY_BYTES)?.unwrap_or_default(),
    })
}

fn variant(bytes: &[u8], budget: &mut WireBudget) -> Result<ParameterizedVariant> {
    let fields = wire_fields_bounded(bytes, budget)?;
    validate_fields(
        &fields,
        &[(1, 2), (2, 2), (3, 0), (4, 0), (5, 0), (8, 2), (9, 2)],
        &[1],
        true,
    )?;
    let mut parameters = Vec::new();
    for field in fields.iter().filter(|f| f.number == 1) {
        ensure!(
            parameters.len() < MAX_MODEL_PARAMETERS,
            "Too many Cursor model parameters"
        );
        parameters.push(parameter(field.data, budget)?);
    }
    validate_model_parameters(&parameters)?;
    let result = ParameterizedVariant {
        parameters,
        is_max_mode: boolean(&fields, 3)?.unwrap_or(false),
        is_default_max_config: boolean(&fields, 4)?,
        is_default_non_max_config: boolean(&fields, 5)?,
        display_name: string(&fields, 2, MAX_DISPLAY_BYTES)?,
        display_name_outside_picker: string(&fields, 8, MAX_DISPLAY_BYTES)?,
        variant_string_representation: string(&fields, 9, MAX_DISPLAY_BYTES)?,
    };
    ensure!(
        result.is_default_max_config != Some(true) || result.is_max_mode,
        "Non-Max variant claims to be the default Max config"
    );
    ensure!(
        result.is_default_non_max_config != Some(true) || !result.is_max_mode,
        "Max variant claims to be the default non-Max config"
    );
    Ok(result)
}

fn model(bytes: &[u8], budget: &mut WireBudget) -> Result<ParameterizedModel> {
    let fields = wire_fields_bounded(bytes, budget)?;
    validate_fields(
        &fields,
        &[
            (1, 2),
            (10, 0),
            (14, 0),
            (15, 0),
            (16, 0),
            (17, 2),
            (18, 2),
            (19, 0),
            (30, 2),
        ],
        &[30],
        true,
    )?;
    let name =
        string(&fields, 1, MAX_NAME_BYTES)?.context("Cursor metadata model name is missing")?;
    ensure!(
        !name.is_empty() && name.trim() == name,
        "Invalid Cursor metadata model name"
    );
    let mut variants = Vec::new();
    let mut parameter_sets = HashSet::new();
    let mut default_max = false;
    let mut default_non_max = false;
    for field in fields.iter().filter(|f| f.number == 30) {
        ensure!(
            variants.len() < MAX_VARIANTS,
            "Too many Cursor model variants"
        );
        let variant = variant(field.data, budget)?;
        let mut parameters: Vec<_> = variant
            .parameters
            .iter()
            .map(|p| (p.id.as_str(), p.value.as_str()))
            .collect();
        parameters.sort_unstable();
        // Use structured keys, not delimiter joins that alias arbitrary values.
        let key = serde_json::to_string(&(variant.is_max_mode, parameters))?;
        ensure!(
            parameter_sets.insert(key),
            "Duplicate Cursor model variant parameter set"
        );
        if variant.is_default_max_config == Some(true) {
            ensure!(!default_max, "Ambiguous default Max config");
            default_max = true;
        }
        if variant.is_default_non_max_config == Some(true) {
            ensure!(!default_non_max, "Ambiguous default non-Max config");
            default_non_max = true;
        }
        variants.push(variant);
    }
    let result = ParameterizedModel {
        name,
        client_display_name: string(&fields, 17, MAX_DISPLAY_BYTES)?,
        server_model_name: string(&fields, 18, MAX_NAME_BYTES)?,
        supports_max_mode: boolean(&fields, 14)?,
        supports_non_max_mode: boolean(&fields, 19)?,
        supports_images: boolean(&fields, 10)?,
        context_token_limit: context_limit(&fields, 15)?,
        context_token_limit_for_max_mode: context_limit(&fields, 16)?,
        variants,
    };
    ensure!(
        result
            .server_model_name
            .as_ref()
            .is_none_or(|name| !name.is_empty() && name.trim() == name),
        "Invalid Cursor metadata server model name"
    );
    for variant in &result.variants {
        ensure!(
            if variant.is_max_mode {
                result.supports_max_mode != Some(false)
            } else {
                result.supports_non_max_mode != Some(false)
            },
            "Cursor model variant contradicts supported modes"
        );
    }
    Ok(result)
}

/// Unframed aiserver.v1.AvailableModelsRequest: use_model_parameters (5) and
/// do_not_use_markdown (7), matching the pinned upstream schema reference.
pub fn available_models_request() -> (String, Vec<u8>) {
    (
        "/aiserver.v1.AiService/AvailableModels".to_owned(),
        vec![0x28, 0x01, 0x38, 0x01],
    )
}

/// Enrich the directly runnable list without inventing model/mode/parameter
/// combinations. Metadata-only rows are explicitly marked for host routing.
pub fn enrich_model_list(base: Value, metadata: &[u8]) -> Result<Value> {
    let mut budget = WireBudget::default();
    let fields = wire_fields_bounded(metadata, &mut budget)?;
    validate_fields(&fields, &[(2, 2)], &[2], true)?;
    let mut models = Vec::new();
    let mut names = HashSet::new();
    for field in fields.iter().filter(|f| f.number == 2) {
        ensure!(models.len() < MAX_MODELS, "Too many Cursor metadata models");
        let model = model(field.data, &mut budget)?;
        ensure!(
            names.insert(model.name.clone()),
            "Duplicate Cursor metadata model"
        );
        models.push(model);
    }
    let mut base = base
        .as_array()
        .context("Cursor model list must be an array")?
        .clone();
    ensure!(
        base.len() <= MAX_MODELS,
        "Too many directly runnable Cursor models"
    );
    let direct_count = base.len();
    let mut ids = HashSet::new();
    for row in &mut base {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .context("Cursor model id is missing")?;
        ensure!(
            !id.is_empty() && ids.insert(id.to_owned()),
            "Invalid or duplicate Cursor model id"
        );
        ensure!(row.is_object(), "Invalid Cursor model row");
        // Only explicit metadata attests image support, never id/name guesses.
        row["supportsImages"] = json!(false);
    }
    let mut matched = HashSet::new();
    for model in models {
        // Identity matches outrank display labels. Different directly runnable
        // variants can legitimately share a picker label; that must not erase
        // an otherwise unambiguous exact-id attestation.
        let mut matches: Vec<_> = base[..direct_count]
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                let id = row["id"].as_str();
                id == Some(model.name.as_str())
                    || model
                        .server_model_name
                        .as_deref()
                        .is_some_and(|server| id == Some(server))
            })
            .map(|(index, _)| index)
            .collect();
        if matches.is_empty() {
            matches = base[..direct_count]
                .iter()
                .enumerate()
                .filter(|(_, row)| {
                    let name = row["name"].as_str();
                    name == Some(model.name.as_str())
                        || model
                            .client_display_name
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .is_some_and(|display| name == Some(display))
                })
                .map(|(index, _)| index)
                .collect();
        }
        ensure!(matches.len() <= 1, "Ambiguous Cursor metadata match");
        let reasoning = model.variants.iter().any(|variant| {
            variant.parameters.iter().any(|p| {
                p.id == "reasoning" || p.id == "effort" || (p.id == "thinking" && p.value == "true")
            })
        });
        let context = if model.supports_non_max_mode == Some(false) {
            model
                .context_token_limit_for_max_mode
                .or(model.context_token_limit)
        } else {
            model.context_token_limit
        };
        let index = if let Some(index) = matches.first() {
            ensure!(
                matched.insert(*index),
                "Multiple metadata models match one Cursor model"
            );
            *index
        } else {
            ensure!(
                ids.insert(model.name.clone()),
                "Metadata-only Cursor model id collision"
            );
            let context = context.unwrap_or(200_000);
            base.push(json!({
                "id":model.name, "name":model.client_display_name.as_deref().unwrap_or(&model.name),
                "reasoning":reasoning, "contextWindow":context, "maxTokens":64_000u32.min(context),
                "supportsImages":false, "metadataOnly":true
            }));
            base.len() - 1
        };
        let row = &mut base[index];
        row["supportsImages"] = json!(model.supports_images == Some(true));
        if let Some(context) = context {
            row["contextWindow"] = json!(context);
            if let Some(max_tokens) = row["maxTokens"].as_u64() {
                row["maxTokens"] = json!(max_tokens.min(u64::from(context)));
            }
        }
        if reasoning {
            row["reasoning"] = json!(true);
        }
        row["parameterized"] = serde_json::to_value(model)?;
    }
    Ok(Value::Array(base))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{bytes_field, varint_field};

    // Independent raw-wire oracle, verified with the pinned upstream
    // decodeAvailableModelsResponse in cursor-wire.ts using Node type stripping.
    // Includes one direct match, one metadata-only Max model, an image-unknown
    // model, and an unrelated unknown non-executable metadata field (#2).
    const METADATA_HEX: &str = concat!(
        "1283020a0c666978747572652d63686174500170019801017880cd108001c0843d8a010c46697874757265204368617492010b7365727665722d63686174",
        "f201410a0f0a07636f6e7465787412043237326b0a100a09726561736f6e696e6712036c6f770a0d0a0466617374120566616c73652801120b46697874757265204c6f77",
        "f2016c0a0d0a07636f6e746578741202316d0a110a09726561736f6e696e671204686967680a0d0a0466617374120566616c736518012001121046697874757265204d61782048696768420c4669787475726520486967684a15666978747572652d636861742d686967682d6d6178",
        "121369676e6f726564206465736372697074696f6e",
        "129d010a0d6d657461646174612d6f6e6c798a01104f6e6c7920696e206d65746164617461500070019801008001c0843d",
        "f2016c0a0d0a07636f6e746578741202316d0a110a09726561736f6e696e671204686967680a0d0a0466617374120566616c736518012001121046697874757265204d61782048696768420c4669787475726520486967684a15666978747572652d636861742d686967682d6d6178",
        "12090a07746578742d6964"
    );

    fn fixture() -> Result<Vec<u8>> {
        (0..METADATA_HEX.len())
            .step_by(2)
            .map(|n| Ok(u8::from_str_radix(&METADATA_HEX[n..n + 2], 16)?))
            .collect()
    }
    fn field(number: u32, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        bytes_field(&mut out, number, bytes);
        out
    }
    fn base() -> Value {
        json!([
            {"id":"server-chat","name":"Fixture Chat","reasoning":false,"supportsImages":false,"contextWindow":200000,"maxTokens":128000},
            {"id":"text-id","name":"Text","reasoning":false,"supportsImages":true,"contextWindow":200000,"maxTokens":64000},
            {"id":"no-metadata","name":"No metadata","reasoning":false,"supportsImages":true,"contextWindow":200000,"maxTokens":64000}
        ])
    }

    #[test]
    fn available_models_raw_oracle_enriches_images_bounds_and_exact_variants() -> Result<()> {
        assert_eq!(
            available_models_request(),
            (
                "/aiserver.v1.AiService/AvailableModels".into(),
                vec![0x28, 1, 0x38, 1]
            )
        );
        let enriched = enrich_model_list(base(), &fixture()?)?;
        assert_eq!(enriched.as_array().context("No array")?.len(), 4);
        let direct = &enriched[0];
        assert_eq!(direct["id"], "server-chat");
        assert_eq!(direct["supportsImages"], true);
        assert_eq!(direct["contextWindow"], 272000);
        assert_eq!(direct["maxTokens"], 128000);
        assert_eq!(direct["reasoning"], true);
        assert!(direct.get("metadataOnly").is_none());
        assert_eq!(
            direct["parameterized"],
            json!({
                "name":"fixture-chat", "clientDisplayName":"Fixture Chat", "serverModelName":"server-chat",
                "supportsImages":true, "supportsMaxMode":true, "supportsNonMaxMode":true,
                "contextTokenLimit":272000, "contextTokenLimitForMaxMode":1000000,
                "variants":[
                    {"parameters":[{"id":"context","value":"272k"},{"id":"reasoning","value":"low"},{"id":"fast","value":"false"}],
                        "isMaxMode":false,"isDefaultNonMaxConfig":true,"displayName":"Fixture Low"},
                    {"parameters":[{"id":"context","value":"1m"},{"id":"reasoning","value":"high"},{"id":"fast","value":"false"}],
                        "isMaxMode":true,"isDefaultMaxConfig":true,"displayName":"Fixture Max High",
                        "displayNameOutsidePicker":"Fixture High","variantStringRepresentation":"fixture-chat-high-max"}
                ]
            })
        );
        assert_eq!(enriched[1]["supportsImages"], false); // metadata absent flag
        assert!(enriched[1]["parameterized"].get("supportsImages").is_none());
        assert_eq!(enriched[2]["supportsImages"], false); // no metadata at all
        assert!(enriched[2].get("parameterized").is_none());
        let only = &enriched[3];
        assert_eq!(only["id"], "metadata-only");
        assert_eq!(only["metadataOnly"], true);
        assert_eq!(only["contextWindow"], 1000000);
        assert_eq!(only["supportsImages"], false); // explicit negative flag
        assert_eq!(
            only["parameterized"]["variants"]
                .as_array()
                .context("No variants")?
                .len(),
            1
        );
        assert_eq!(only["parameterized"]["variants"][0]["isMaxMode"], true);
        Ok(())
    }

    #[test]
    fn supported_modes_do_not_fabricate_parameter_combinations() -> Result<()> {
        let parameter = [field(1, b"reasoning"), field(2, b"low")].concat();
        let variant = field(1, &parameter); // only non-Max variant explicitly advertised
        let mut model = field(1, b"text-id");
        varint_field(&mut model, 14, 1); // Max is supported, but no Max variant here
        varint_field(&mut model, 19, 1);
        varint_field(&mut model, 15, 32000);
        bytes_field(&mut model, 30, &variant);
        let result = enrich_model_list(base(), &field(2, &model))?;
        let variants = result[1]["parameterized"]["variants"]
            .as_array()
            .context("No variants")?;
        assert_eq!(variants.len(), 1);
        assert_eq!(variants[0]["isMaxMode"], false);
        assert_eq!(result[1]["maxTokens"], 32000);
        assert_eq!(result[1]["supportsImages"], false);
        Ok(())
    }

    #[test]
    fn metadata_matches_id_or_name_but_rejects_ambiguous_matches() -> Result<()> {
        let raw = fixture()?;
        let by_name = json!([{"id":"different-id","name":"Fixture Chat","contextWindow":200000,"maxTokens":64000}]);
        let result = enrich_model_list(by_name, &raw)?;
        assert_eq!(result[0]["parameterized"]["name"], "fixture-chat");
        let id_over_label = json!([
            {"id":"server-chat","name":"First"}, {"id":"other","name":"Fixture Chat"}
        ]);
        let result = enrich_model_list(id_over_label, &raw)?;
        assert_eq!(result[0]["parameterized"]["name"], "fixture-chat");
        assert_eq!(result[1]["supportsImages"], false);
        assert!(result[1].get("parameterized").is_none());
        let duplicate_ids = json!([
            {"id":"server-chat","name":"First"}, {"id":"fixture-chat","name":"Second"}
        ]);
        assert!(enrich_model_list(duplicate_ids, &raw).is_err());
        let duplicate_labels = json!([
            {"id":"other-id","name":"Fixture Chat"}, {"id":"other","name":"Fixture Chat"}
        ]);
        assert!(enrich_model_list(duplicate_labels, &raw).is_err());
        let mut models = field(2, &[field(1, b"first"), field(18, b"server-chat")].concat());
        bytes_field(
            &mut models,
            2,
            &[field(1, b"second"), field(18, b"server-chat")].concat(),
        );
        assert!(enrich_model_list(base(), &models).is_err());
        assert!(enrich_model_list(json!([{"id":"duplicate"},{"id":"duplicate"}]), b"").is_err());
        Ok(())
    }

    #[test]
    fn malformed_or_ambiguous_metadata_is_rejected() -> Result<()> {
        let name = field(1, b"test");
        let parameter = [field(1, b"reasoning"), field(2, b"high")].concat();
        let variant = field(1, &parameter);
        for extra in [
            [vec![0x50, 1], vec![0x50, 0]].concat(), // duplicate image flag
            field(10, b"true"),                      // wrong known wire type
            vec![0x50, 2],                           // noncanonical bool
            vec![0x78, 0],                           // zero context bound
            vec![0x78, 0xff, 0xff, 0xff, 0xff, 0x1f], // overflowing bound
            field(17, &[0xff]),                      // invalid UTF-8
            field(1, b"different"),                  // duplicate model name
            [field(30, &variant), field(30, &variant)].concat(), // duplicate variant
            field(30, &[variant.as_slice(), variant.as_slice()].concat()), // duplicate parameter id
            field(30, &field(1, &field(2, b"missing-id"))),
            [
                vec![0x70, 0],
                field(30, &[vec![0x18, 1], variant.clone()].concat()),
            ]
            .concat(), // unsupported Max
            field(30, &[vec![0x20, 1], variant.clone()].concat()), // non-Max default Max config
            field(30, &[vec![0x18, 1, 0x28, 1], variant.clone()].concat()), // Max default non-Max config
        ] {
            assert!(enrich_model_list(
                json!([]),
                &field(2, &[name.as_slice(), extra.as_slice()].concat())
            )
            .is_err());
        }
        assert!(enrich_model_list(json!([]), &[0xff]).is_err());
        assert!(enrich_model_list(json!([]), &field(2, b"")).is_err());
        assert!(enrich_model_list(json!([]), &field(2, &field(1, b""))).is_err());
        assert!(
            enrich_model_list(json!([]), &[field(2, &name), field(2, &name)].concat()).is_err()
        );
        assert!(enrich_model_list(json!({}), b"").is_err());
        Ok(())
    }

    #[test]
    fn omitted_parameter_value_matches_explicit_empty_raw_wire_oracle() -> Result<()> {
        // Both byte sequences decode to {id:"reasoning", value:""} with
        // vendor/pi-cursor's decodeAvailableModelsResponse. No JS production
        // protocol dependency is used here.
        let omitted = b"\x0a\x09reasoning";
        let explicit = b"\x0a\x09reasoning\x12\x00";
        let metadata = |parameter: &[u8]| {
            let mut model = field(1, b"server-chat");
            varint_field(&mut model, 10, 1); // explicit image support survives
            varint_field(&mut model, 19, 1);
            bytes_field(&mut model, 18, b"server-chat");
            let mut variant = field(1, parameter);
            varint_field(&mut variant, 5, 1);
            bytes_field(&mut model, 30, &variant);
            field(2, &model)
        };
        let result = enrich_model_list(base(), &metadata(omitted))?;
        assert_eq!(result, enrich_model_list(base(), &metadata(explicit))?);
        assert_eq!(result[0]["supportsImages"], true);
        assert_eq!(result[0]["reasoning"], true);
        assert_eq!(result[0]["parameterized"]["serverModelName"], "server-chat");
        assert_eq!(
            result[0]["parameterized"]["variants"][0]["parameters"],
            json!([{"id":"reasoning", "value":""}])
        );
        assert_eq!(
            result[0]["parameterized"]["variants"][0]["isDefaultNonMaxConfig"],
            true
        );
        for invalid in [
            vec![],
            field(1, b""),
            field(1, &[0xff]),
            [field(1, b"reasoning"), field(2, &[0xff])].concat(),
            [omitted.as_slice(), &field(1, b"other")].concat(),
            [explicit.as_slice(), &field(2, b"")].concat(),
            [omitted.as_slice(), &[0x10, 0]].concat(), // wrong value wire type
            [omitted.as_slice(), &[0x12, 2, 0]].concat(), // truncated value
        ] {
            assert!(enrich_model_list(base(), &metadata(&invalid)).is_err());
        }
        Ok(())
    }

    #[test]
    fn metadata_parameter_and_field_budgets_are_bounded() -> Result<()> {
        for omit_value in [false, true] {
            let mut variant = Vec::new();
            for n in 0..MAX_MODEL_PARAMETERS {
                let mut parameter = field(1, n.to_string().as_bytes());
                if !omit_value {
                    bytes_field(&mut parameter, 2, b"high");
                }
                bytes_field(&mut variant, 1, &parameter);
            }
            let model = [field(1, b"test"), field(30, &variant)].concat();
            assert!(enrich_model_list(json!([]), &field(2, &model)).is_ok());
            bytes_field(&mut variant, 1, &field(1, b"one-too-many"));
            let model = [field(1, b"test"), field(30, &variant)].concat();
            assert!(enrich_model_list(json!([]), &field(2, &model)).is_err());
        }
        let model = [
            field(1, b"test"),
            [0x10, 0x00].repeat(super::super::MAX_WIRE_FIELDS),
        ]
        .concat();
        assert!(enrich_model_list(json!([]), &field(2, &model)).is_err());
        Ok(())
    }
}
