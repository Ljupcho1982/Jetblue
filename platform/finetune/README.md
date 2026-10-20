# Fine-tuning the deal writer

Teaches an open-source model to write replies in your brokers' style. The rules engine still decides the action and the price; the fine-tuned model only changes the wording.

## Steps
1. **Collect data.** Use the platform (Deals page) and approve or edit drafts. Edited replies are the most valuable. Then download `finetune.jsonl` from the Training page. Aim for 200+ reviewed examples; below ~50 the scripts refuse to continue.
2. **Clean and split** (no GPU needed):
   ```
   python prepare_data.py finetune.jsonl --db ../data/db.json
   ```
   Drops duplicates, malformed rows, binding language, amounts not in the facts, and replies that leak a floor or minimum lease from your inventory. Writes `data/train.jsonl` and `data/val.jsonl`.
3. **Check the formatting** (no GPU needed): `python train.py --data data --dry-run`
4. **Train** on a machine with an NVIDIA GPU (8B in 4-bit needs about 12 GB; for less use `--model unsloth/Llama-3.2-3B-Instruct`):
   ```
   pip install -r requirements.txt
   python train.py --data data --out outputs/deal-writer
   ```
   Saves the LoRA adapter, a quantized GGUF, and a `Modelfile`.
5. **Load into Ollama and use it:**
   ```
   cd outputs/deal-writer/gguf && ollama create deal-writer -f Modelfile
   cd ../../../.. && LLM_PROVIDER=ollama LLM_MODEL=deal-writer node server.js
   ```
6. **Re-run the Training page scenarios** and read a sample of drafts before trusting it. Compare against the base model on the same offers.

## Notes
- The exported system prompt is the playbook instructions only. At run time the platform adds company, tone and style examples. A fine-tuned model usually copes, but if drafts drift, shorten `buildSystem` in `../llm.js` to match training.
- The training script's `train_on_responses_only` markers are for Llama 3 models. For Qwen, Mistral or others, change the two header strings to that model's chat template.
- Data from the template-only mode is included in the export (the template text with any broker edits). Edited rows teach more than unedited template rows, so prefer a few hundred reviewed edits.
- Fine-tuning improves style and tone. It will not make the model reliable on prices: keep the guardrail and the broker approval step.

## Tested vs not tested
Tested here: `prepare_data.py` (`python -m unittest test_prepare`), the `--dry-run` path, and the export-to-prepare pipeline with real platform output. **Not tested:** `train.py` past the dry run. This environment has no GPU. Unsloth and TRL change their APIs often, so expect to adjust arguments (`SFTConfig`, GGUF export) on first run.
