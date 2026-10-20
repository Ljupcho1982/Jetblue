#!/usr/bin/env python3
"""LoRA fine-tune an open-source chat model on broker-approved replies (Unsloth + TRL).

Needs an NVIDIA GPU (8B model in 4-bit: about 12 GB VRAM; use --model for a 3B model on less).
Only the assistant reply contributes to the loss, so the model learns to write replies,
not to repeat the facts or the system prompt.

  python train.py --data data --out outputs/deal-writer
  python train.py --data data --dry-run        # check data and formatting, no GPU needed
"""
import argparse
import json
from pathlib import Path


def load_rows(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data", help="directory with train.jsonl and val.jsonl")
    ap.add_argument("--out", default="outputs/deal-writer")
    ap.add_argument("--model", default="unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit",
                    help="e.g. unsloth/Llama-3.2-3B-Instruct for smaller GPUs")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq", type=int, default=2048)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--gguf", default="q4_k_m", help="GGUF quantization for Ollama, or 'none' to skip export")
    ap.add_argument("--dry-run", action="store_true", help="validate data only")
    a = ap.parse_args()

    train_rows = load_rows(Path(a.data) / "train.jsonl")
    val_rows = load_rows(Path(a.data) / "val.jsonl")
    print("train rows: %d, validation rows: %d" % (len(train_rows), len(val_rows)))
    if a.dry_run:
        r = train_rows[0]["messages"]
        print("first example:\n  FACTS: %s\n  REPLY: %s" % (r[1]["content"][:200], r[2]["content"][:300]))
        return

    # Heavy imports after argument parsing so --help and --dry-run work without a GPU stack.
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    model, tok = FastLanguageModel.from_pretrained(a.model, max_seq_length=a.max_seq, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model, r=a.rank, lora_alpha=a.rank, lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=42,
    )

    def to_text(row):
        return {"text": tok.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False)}

    train_ds = Dataset.from_list(train_rows).map(to_text)
    val_ds = Dataset.from_list(val_rows).map(to_text)

    trainer = SFTTrainer(
        model=model, tokenizer=tok, train_dataset=train_ds, eval_dataset=val_ds,
        args=SFTConfig(
            dataset_text_field="text", max_seq_length=a.max_seq,
            per_device_train_batch_size=a.batch, gradient_accumulation_steps=a.accum,
            num_train_epochs=a.epochs, learning_rate=a.lr, warmup_ratio=0.05, lr_scheduler_type="cosine",
            weight_decay=0.01, optim="adamw_8bit", logging_steps=5, eval_strategy="epoch",
            save_strategy="epoch", output_dir=a.out + "/checkpoints", seed=42, report_to="none",
        ),
    )
    # Llama 3 template markers. For another model family, change these to its header tokens.
    trainer = train_on_responses_only(
        trainer,
        instruction_part="<|start_header_id|>user<|end_header_id|>\n\n",
        response_part="<|start_header_id|>assistant<|end_header_id|>\n\n",
    )
    result = trainer.train()
    metrics = trainer.evaluate()
    print("train loss %.3f, validation loss %.3f" % (result.training_loss, metrics["eval_loss"]))

    model.save_pretrained(a.out + "/lora")
    tok.save_pretrained(a.out + "/lora")
    print("LoRA adapter saved to", a.out + "/lora")

    if a.gguf != "none":
        model.save_pretrained_gguf(a.out + "/gguf", tok, quantization_method=a.gguf)
        modelfile = Path(a.out) / "gguf" / "Modelfile"
        ggufs = sorted((Path(a.out) / "gguf").glob("*.gguf"))
        if ggufs:
            system = train_rows[0]["messages"][0]["content"]
            modelfile.write_text('FROM ./%s\nPARAMETER temperature 0.3\nSYSTEM """%s"""\n' % (ggufs[0].name, system))
            print("\nLoad into Ollama:\n  cd %s/gguf && ollama create deal-writer -f Modelfile" % a.out)
            print("Then run the platform with:\n  LLM_PROVIDER=ollama LLM_MODEL=deal-writer node server.js")


if __name__ == "__main__":
    main()
