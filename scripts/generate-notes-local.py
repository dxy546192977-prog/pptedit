"""Isolated MLX worker. Only reads local weights and writes a validated JSON result."""
import argparse
import json
from pathlib import Path
from local_notes import parse_response


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    from mlx_lm import load, generate
    from mlx_lm.sample_utils import make_sampler
    model, tokenizer = load(args.model)
    prompt = tokenizer.apply_chat_template(
        [{'role': 'user', 'content': Path(args.prompt).read_text(encoding='utf-8')}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False)
    result = generate(model, tokenizer, prompt=prompt, max_tokens=8192,
                      sampler=make_sampler(temp=0.2), verbose=False)
    Path(args.output).write_text(json.dumps(parse_response(result), ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
