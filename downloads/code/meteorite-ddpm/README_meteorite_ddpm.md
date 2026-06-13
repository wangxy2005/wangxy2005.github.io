# Meteorite DDPM Workflow

This folder contains a pure PyTorch DDPM baseline for generating meteorite images.

## Train

Quick CUDA run (optimized for RTX 5090 32GB):

```bash
python train_meteorite_ddpm.py train --device cuda --amp
```

Default training config (tuned for 5090):

| Parameter | Value | Note |
|-----------|-------|------|
| epochs | 1200 | ~49200 步，DDPM 需要充足训练 |
| batch-size | 64 | 充分利用 32GB 显存 |
| num-workers | 4 | 多进程数据加载 |
| AMP dtype | bf16 | 5090 原生支持，更稳定 |
| torch.compile | auto | CUDA 下自动启用 |
| channels_last | auto | NHWC 布局，Tensor Core 更高效 |
| cudnn.benchmark | True | 自动选择最快卷积算法 |
| EMA decay | 0.9999 | 指数移动平均，提升生成质量 |
| LR scheduler | Cosine | 余弦退火到 1e-6 |

More conservative run for limited GPU memory:

```bash
python train_meteorite_ddpm.py train --device cuda --amp --batch-size 8 --base-channels 48
```

Resume training:

```bash
python train_meteorite_ddpm.py train --device cuda --amp --resume meteorite_ddpm_output/checkpoints/latest.pt
```

Useful outputs:

- `meteorite_ddpm_output/checkpoints/latest.pt`
- `meteorite_ddpm_output/samples/`
- `meteorite_ddpm_output/training_config.json`

## Generate Final Images

For final evaluation, generate exactly 1000 images into `generated_pictures/`.
Do not pass `--save-grid` for the final run, because the evaluation folder should contain only generated images.

```bash
python train_meteorite_ddpm.py generate \
  --checkpoint meteorite_ddpm_output/checkpoints/latest.pt \
  --generated-dir generated_pictures \
  --num-images 1000 \
  --batch-size 64 \
  --device cuda \
  --clean-generated
```

The generate command defaults to full 1000-step DDPM sampling for best quality.
It automatically uses EMA weights when available in the checkpoint.
Use `--sample-steps 250` for faster DDIM sampling (lower quality).

## Evaluate FID

Run from this `HW3/` directory:

```bash
python evaluate_fid.py
```

The script compares:

- `meteorite/`
- `generated_pictures/`

It resizes and white-pads both folders to the InceptionV3 input size internally.
Results are saved to `evaluation_results/fid_metrics.json`.
