from __future__ import annotations

import argparse
import json
import math
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageOps
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.utils import make_grid, save_image
from tqdm import tqdm


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = SCRIPT_DIR / "meteorite"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / "meteorite_ddpm_output_256"
DEFAULT_GENERATED_DIR = SCRIPT_DIR / "generated_pictures_256"
DEFAULT_IMAGE_SIZE = 256
DEFAULT_BATCH_SIZE = 16
DEFAULT_BASE_CHANNELS = 96
DEFAULT_SAMPLE_STEPS = 250
DEFAULT_GENERATE_SAMPLE_STEPS = 500
DEFAULT_SAMPLER = "ddim"
DEFAULT_DDIM_ETA = 0.0
DEFAULT_TIMESTEP_SPACING = "quadratic"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = True


def resolve_device(device: str) -> torch.device:
    if device == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(device)


def format_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours:d}h {minutes:02d}m {seconds:02d}s"
    if minutes:
        return f"{minutes:d}m {seconds:02d}s"
    return f"{seconds:d}s"


class ResizeWithWhitePadding:
    def __init__(self, size: int) -> None:
        self.size = size

    def __call__(self, image: Image.Image) -> Image.Image:
        image = ImageOps.contain(
            image.convert("RGB"),
            (self.size, self.size),
            method=Image.Resampling.BICUBIC,
        )
        canvas = Image.new("RGB", (self.size, self.size), "white")
        canvas.paste(image, ((self.size - image.width) // 2, (self.size - image.height) // 2))
        return canvas


class MeteoriteDataset(Dataset):
    def __init__(
        self,
        image_dir: Path,
        image_size: int,
        augment: bool = True,
        max_images: int | None = None,
    ) -> None:
        self.image_dir = Path(image_dir)
        if not self.image_dir.is_dir():
            raise FileNotFoundError(f"Image directory not found: {self.image_dir}")

        self.image_paths = sorted(
            path
            for path in self.image_dir.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        )
        if max_images is not None:
            self.image_paths = self.image_paths[:max_images]
        if not self.image_paths:
            raise FileNotFoundError(f"No training images found in {self.image_dir}")

        ops: list[transforms.Compose | transforms.RandomHorizontalFlip | transforms.ColorJitter] = [
            ResizeWithWhitePadding(image_size)
        ]
        if augment:
            ops.extend(
                [
                    transforms.RandomHorizontalFlip(p=0.5),
                    transforms.RandomApply(
                        [transforms.ColorJitter(brightness=0.08, contrast=0.08, saturation=0.05)],
                        p=0.35,
                    ),
                ]
            )
        ops.extend(
            [
                transforms.ToTensor(),
                transforms.Normalize(mean=[0.5, 0.5, 0.5], std=[0.5, 0.5, 0.5]),
            ]
        )
        self.transform = transforms.Compose(ops)

    def __len__(self) -> int:
        return len(self.image_paths)

    def __getitem__(self, index: int) -> torch.Tensor:
        with Image.open(self.image_paths[index]) as image:
            return self.transform(image)


class SinusoidalPositionEmbeddings(nn.Module):
    def __init__(self, dim: int) -> None:
        super().__init__()
        self.dim = dim

    def forward(self, timesteps: torch.Tensor) -> torch.Tensor:
        device = timesteps.device
        half_dim = self.dim // 2
        scale = math.log(10000) / max(half_dim - 1, 1)
        embeddings = torch.exp(torch.arange(half_dim, device=device) * -scale)
        embeddings = timesteps[:, None].float() * embeddings[None, :]
        embeddings = torch.cat((embeddings.sin(), embeddings.cos()), dim=-1)
        if self.dim % 2 == 1:
            embeddings = F.pad(embeddings, (0, 1))
        return embeddings


def group_norm(channels: int) -> nn.GroupNorm:
    groups = min(8, channels)
    while channels % groups != 0:
        groups -= 1
    return nn.GroupNorm(groups, channels)


class ResBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, time_dim: int) -> None:
        super().__init__()
        self.time_mlp = nn.Sequential(nn.SiLU(), nn.Linear(time_dim, out_channels))
        self.block1 = nn.Sequential(
            group_norm(in_channels),
            nn.SiLU(),
            nn.Conv2d(in_channels, out_channels, kernel_size=3, padding=1),
        )
        self.block2 = nn.Sequential(
            group_norm(out_channels),
            nn.SiLU(),
            nn.Conv2d(out_channels, out_channels, kernel_size=3, padding=1),
        )
        self.skip = (
            nn.Conv2d(in_channels, out_channels, kernel_size=1)
            if in_channels != out_channels
            else nn.Identity()
        )

    def forward(self, x: torch.Tensor, time_emb: torch.Tensor) -> torch.Tensor:
        h = self.block1(x)
        h = h + self.time_mlp(time_emb)[:, :, None, None]
        h = self.block2(h)
        return h + self.skip(x)


class Downsample(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv = nn.Conv2d(channels, channels, kernel_size=4, stride=2, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv(x)


class Upsample(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv = nn.ConvTranspose2d(channels, channels, kernel_size=4, stride=2, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv(x)


class TinyUNet(nn.Module):
    def __init__(self, image_channels: int = 3, base_channels: int = 64, time_dim: int = 256) -> None:
        super().__init__()
        c1, c2, c3, c4 = base_channels, base_channels * 2, base_channels * 4, base_channels * 8

        self.time_mlp = nn.Sequential(
            SinusoidalPositionEmbeddings(time_dim),
            nn.Linear(time_dim, time_dim),
            nn.SiLU(),
            nn.Linear(time_dim, time_dim),
        )
        self.init_conv = nn.Conv2d(image_channels, c1, kernel_size=3, padding=1)

        self.down1 = ResBlock(c1, c1, time_dim)
        self.downsample1 = Downsample(c1)
        self.down2 = ResBlock(c1, c2, time_dim)
        self.downsample2 = Downsample(c2)
        self.down3 = ResBlock(c2, c3, time_dim)
        self.downsample3 = Downsample(c3)

        self.mid1 = ResBlock(c3, c4, time_dim)
        self.mid2 = ResBlock(c4, c3, time_dim)

        self.upsample3 = Upsample(c3)
        self.up3 = ResBlock(c3 + c3, c2, time_dim)
        self.upsample2 = Upsample(c2)
        self.up2 = ResBlock(c2 + c2, c1, time_dim)
        self.upsample1 = Upsample(c1)
        self.up1 = ResBlock(c1 + c1, c1, time_dim)

        self.out = nn.Sequential(
            group_norm(c1),
            nn.SiLU(),
            nn.Conv2d(c1, image_channels, kernel_size=3, padding=1),
        )

    def forward(self, x: torch.Tensor, timesteps: torch.Tensor) -> torch.Tensor:
        time_emb = self.time_mlp(timesteps)
        x = self.init_conv(x)

        skip1 = self.down1(x, time_emb)
        x = self.downsample1(skip1)
        skip2 = self.down2(x, time_emb)
        x = self.downsample2(skip2)
        skip3 = self.down3(x, time_emb)
        x = self.downsample3(skip3)

        x = self.mid1(x, time_emb)
        x = self.mid2(x, time_emb)

        x = self.upsample3(x)
        x = torch.cat([x, skip3], dim=1)
        x = self.up3(x, time_emb)
        x = self.upsample2(x)
        x = torch.cat([x, skip2], dim=1)
        x = self.up2(x, time_emb)
        x = self.upsample1(x)
        x = torch.cat([x, skip1], dim=1)
        x = self.up1(x, time_emb)
        return self.out(x)


def extract(values: torch.Tensor, timesteps: torch.Tensor, x_shape: torch.Size) -> torch.Tensor:
    out = values.gather(-1, timesteps)
    return out.reshape(timesteps.shape[0], *((1,) * (len(x_shape) - 1)))


class DDPM:
    def __init__(
        self,
        timesteps: int = 1000,
        beta_start: float = 1e-4,
        beta_end: float = 0.02,
        device: torch.device | str = "cpu",
    ) -> None:
        self.timesteps = timesteps
        self.device = torch.device(device)
        self.betas = torch.linspace(beta_start, beta_end, timesteps, device=self.device)
        self.alphas = 1.0 - self.betas
        self.alphas_cumprod = torch.cumprod(self.alphas, dim=0)
        self.alphas_cumprod_prev = F.pad(self.alphas_cumprod[:-1], (1, 0), value=1.0)
        self.sqrt_recip_alphas = torch.sqrt(1.0 / self.alphas)
        self.sqrt_alphas_cumprod = torch.sqrt(self.alphas_cumprod)
        self.sqrt_one_minus_alphas_cumprod = torch.sqrt(1.0 - self.alphas_cumprod)
        self.posterior_variance = (
            self.betas * (1.0 - self.alphas_cumprod_prev) / (1.0 - self.alphas_cumprod)
        )

    def q_sample(self, x_start: torch.Tensor, timesteps: torch.Tensor, noise: torch.Tensor) -> torch.Tensor:
        return (
            extract(self.sqrt_alphas_cumprod, timesteps, x_start.shape) * x_start
            + extract(self.sqrt_one_minus_alphas_cumprod, timesteps, x_start.shape) * noise
        )

    @torch.no_grad()
    def p_sample(self, model: nn.Module, x: torch.Tensor, timesteps: torch.Tensor) -> torch.Tensor:
        betas_t = extract(self.betas, timesteps, x.shape)
        sqrt_one_minus_alphas_cumprod_t = extract(self.sqrt_one_minus_alphas_cumprod, timesteps, x.shape)
        sqrt_recip_alphas_t = extract(self.sqrt_recip_alphas, timesteps, x.shape)

        model_mean = sqrt_recip_alphas_t * (x - betas_t * model(x, timesteps) / sqrt_one_minus_alphas_cumprod_t)
        posterior_variance_t = extract(self.posterior_variance, timesteps, x.shape)

        noise = torch.randn_like(x)
        nonzero_mask = (timesteps != 0).float().reshape(x.shape[0], *((1,) * (len(x.shape) - 1)))
        return model_mean + nonzero_mask * torch.sqrt(posterior_variance_t.clamp(min=1e-20)) * noise

    @torch.no_grad()
    def ddim_p_sample(
        self,
        model: nn.Module,
        x: torch.Tensor,
        t: torch.Tensor,
        t_prev: torch.Tensor,
        eta: float = 0.0,
    ) -> torch.Tensor:
        alpha_t = extract(self.alphas_cumprod, t, x.shape)
        safe_t_prev = t_prev.clamp(min=0)
        alpha_prev = extract(self.alphas_cumprod, safe_t_prev, x.shape)
        mask = (t_prev >= 0).float().reshape(-1, *([1] * (len(x.shape) - 1)))
        alpha_prev = mask * alpha_prev + (1 - mask) * 1.0

        eps = model(x, t)
        x0_pred = (x - torch.sqrt(1.0 - alpha_t) * eps) / torch.sqrt(alpha_t)
        x0_pred = x0_pred.clamp(-1, 1)
        sigma = eta * torch.sqrt(
            ((1 - alpha_prev) / (1 - alpha_t)).clamp(min=0)
            * (1 - alpha_t / alpha_prev).clamp(min=0)
        )
        dir_xt = torch.sqrt((1 - alpha_prev - sigma.square()).clamp(min=0)) * eps
        noise = torch.randn_like(x) if eta > 0 else torch.zeros_like(x)
        return torch.sqrt(alpha_prev) * x0_pred + dir_xt + sigma * noise

    def make_timestep_pairs(
        self,
        sample_steps: int,
        spacing: str = "linear",
    ) -> list[tuple[int, int]]:
        sample_steps = max(2, min(sample_steps, self.timesteps))
        if spacing == "linear":
            seq = torch.linspace(0, self.timesteps - 1, sample_steps)
        elif spacing == "quadratic":
            seq = torch.linspace(0, math.sqrt(self.timesteps - 1), sample_steps).square()
        else:
            raise ValueError(f"Unsupported timestep spacing: {spacing}")

        seq = sorted(set(int(round(s.item())) for s in seq))
        rev_seq = seq[::-1]
        return [(rev_seq[i], rev_seq[i + 1] if i + 1 < len(rev_seq) else -1) for i in range(len(rev_seq))]

    @torch.no_grad()
    def sample(
        self,
        model: nn.Module,
        image_size: int,
        batch_size: int,
        channels: int = 3,
        sample_steps: int | None = None,
        sampler: str = "auto",
        ddim_eta: float = 0.0,
        timestep_spacing: str = "linear",
        progress: bool = True,
    ) -> torch.Tensor:
        model.eval()
        image = torch.randn((batch_size, channels, image_size, image_size), device=self.device)
        use_ddim = sampler == "ddim" or (
            sampler == "auto" and sample_steps is not None and sample_steps < self.timesteps
        )
        if not use_ddim:
            step_sequence = list(reversed(range(self.timesteps)))
            iterator = step_sequence
            if progress:
                iterator = tqdm(iterator, desc="Sampling", leave=False)
            for i in iterator:
                t = torch.full((batch_size,), i, device=self.device, dtype=torch.long)
                image = self.p_sample(model, image, t)
        else:
            pairs = self.make_timestep_pairs(sample_steps or self.timesteps, spacing=timestep_spacing)
            iterator = pairs
            if progress:
                iterator = tqdm(iterator, desc="Sampling (DDIM)", leave=False)
            for t_val, t_prev_val in iterator:
                t = torch.full((batch_size,), t_val, device=self.device, dtype=torch.long)
                t_prev = torch.full((batch_size,), t_prev_val, device=self.device, dtype=torch.long)
                image = self.ddim_p_sample(model, image, t, t_prev, eta=ddim_eta)
        return image.clamp(-1, 1)


@dataclass
class TrainConfig:
    image_size: int = DEFAULT_IMAGE_SIZE
    batch_size: int = DEFAULT_BATCH_SIZE
    epochs: int = 1200
    learning_rate: float = 2e-4
    timesteps: int = 1000
    base_channels: int = DEFAULT_BASE_CHANNELS
    num_workers: int = 4
    save_every_epochs: int = 100
    sample_every_epochs: int = 100
    sample_count: int = 16
    seed: int = 42
    max_train_images: int | None = None
    amp: bool = False
    ema_decay: float = 0.9999


def denormalize(images: torch.Tensor) -> torch.Tensor:
    return (images + 1.0) / 2.0


class EMA:
    def __init__(self, model: nn.Module, decay: float = 0.9999) -> None:
        self.decay = decay
        self.shadow = {k: v.clone().detach() for k, v in model.state_dict().items()}

    @torch.no_grad()
    def update(self, model: nn.Module) -> None:
        for k, v in model.state_dict().items():
            self.shadow[k].lerp_(v, 1.0 - self.decay)

    def state_dict(self) -> dict[str, torch.Tensor]:
        return self.shadow

    def load_state_dict(self, state_dict: dict[str, torch.Tensor]) -> None:
        self.shadow = {k: v.clone().detach() for k, v in state_dict.items()}

    def apply_to(self, model: nn.Module) -> None:
        model.load_state_dict(self.shadow)


def _unwrap_model(model: nn.Module) -> nn.Module:
    return getattr(model, "_orig_mod", model)


def save_checkpoint(
    path: Path,
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    epoch: int,
    global_step: int,
    config: TrainConfig,
    ema: EMA | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "model": _unwrap_model(model).state_dict(),
        "optimizer": optimizer.state_dict(),
        "epoch": epoch,
        "global_step": global_step,
        "config": asdict(config),
    }
    if ema is not None:
        data["ema"] = ema.state_dict()
    torch.save(data, path)


def load_checkpoint(
    checkpoint_path: Path,
    model: nn.Module,
    optimizer: torch.optim.Optimizer | None = None,
    device: torch.device | str = "cpu",
) -> tuple[int, int, dict]:
    checkpoint = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(checkpoint["model"])
    if optimizer is not None and "optimizer" in checkpoint:
        optimizer.load_state_dict(checkpoint["optimizer"])
    return int(checkpoint.get("epoch", 0)), int(checkpoint.get("global_step", 0)), checkpoint.get("config", {})


def train(args: argparse.Namespace) -> Path:
    config = TrainConfig(
        image_size=args.image_size,
        batch_size=args.batch_size,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        timesteps=args.timesteps,
        base_channels=args.base_channels,
        num_workers=args.num_workers,
        save_every_epochs=args.save_every_epochs,
        sample_every_epochs=args.sample_every_epochs,
        sample_count=args.sample_count,
        seed=args.seed,
        max_train_images=args.max_train_images,
        amp=args.amp,
        ema_decay=args.ema_decay,
    )
    seed_everything(config.seed)
    device = resolve_device(args.device)
    output_dir = Path(args.output_dir)
    samples_dir = output_dir / "samples"
    checkpoints_dir = output_dir / "checkpoints"
    output_dir.mkdir(parents=True, exist_ok=True)
    samples_dir.mkdir(parents=True, exist_ok=True)
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "training_config.json").write_text(json.dumps(asdict(config), indent=2), encoding="utf-8")

    dataset = MeteoriteDataset(
        image_dir=Path(args.data_dir),
        image_size=config.image_size,
        augment=not args.no_augment,
        max_images=config.max_train_images,
    )
    dataloader = DataLoader(
        dataset,
        batch_size=config.batch_size,
        shuffle=True,
        num_workers=config.num_workers,
        pin_memory=device.type == "cuda",
        drop_last=True,
        persistent_workers=config.num_workers > 0,
        prefetch_factor=2 if config.num_workers > 0 else None,
    )
    model = TinyUNet(base_channels=config.base_channels).to(device)
    model = model.to(memory_format=torch.channels_last)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate)
    total_steps = len(dataloader) * config.epochs
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps, eta_min=1e-6)
    ddpm = DDPM(timesteps=config.timesteps, device=device)
    scaler = torch.amp.GradScaler("cuda", enabled=config.amp and device.type == "cuda")
    ema = EMA(model, decay=config.ema_decay)

    start_epoch = 0
    global_step = 0
    if args.resume:
        resume_epoch, global_step, _ = load_checkpoint(Path(args.resume), model, optimizer, device)
        start_epoch = resume_epoch
        checkpoint_data = torch.load(Path(args.resume), map_location=device)
        if "ema" in checkpoint_data:
            ema.load_state_dict(checkpoint_data["ema"])
        else:
            ema = EMA(model, decay=config.ema_decay)
        for _ in range(global_step):
            scheduler.step()
        print(f"Resumed from {args.resume} at epoch {start_epoch}, global_step {global_step}")

    if device.type == "cuda":
        model = torch.compile(model)

    print(f"Device: {device}")
    print(f"Training images: {len(dataset)}")
    print(f"Output dir: {output_dir}")
    print(f"Epochs: {start_epoch + 1}-{config.epochs} ({config.epochs - start_epoch} remaining)")
    print(f"Steps/epoch: {len(dataloader)}, total steps: {total_steps}")

    latest_checkpoint = checkpoints_dir / "latest.pt"
    train_start_time = time.perf_counter()
    completed_epoch_durations: list[float] = []
    for epoch in range(start_epoch, config.epochs):
        model.train()
        epoch_start_time = time.perf_counter()
        progress = tqdm(
            dataloader,
            desc=f"Epoch {epoch + 1}/{config.epochs}",
            unit="batch",
        )
        running_loss = 0.0
        for step, clean_images in enumerate(progress, start=1):
            clean_images = clean_images.to(device, non_blocking=True, memory_format=torch.channels_last)
            noise = torch.randn_like(clean_images)
            timesteps = torch.randint(0, config.timesteps, (clean_images.shape[0],), device=device).long()
            noisy_images = ddpm.q_sample(clean_images, timesteps, noise)

            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=config.amp and device.type == "cuda", dtype=torch.bfloat16):
                noise_pred = model(noisy_images, timesteps)
                loss = F.mse_loss(noise_pred, noise)

            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()
            ema.update(_unwrap_model(model))

            global_step += 1
            running_loss += loss.item()
            elapsed_total = time.perf_counter() - train_start_time
            progress.set_postfix(
                loss=f"{running_loss / step:.4f}",
                lr=f"{scheduler.get_last_lr()[0]:.2e}",
                elapsed=format_duration(elapsed_total),
            )

        epoch_number = epoch + 1
        epoch_duration = time.perf_counter() - epoch_start_time
        completed_epoch_durations.append(epoch_duration)
        elapsed_total = time.perf_counter() - train_start_time
        avg_epoch_duration = sum(completed_epoch_durations) / len(completed_epoch_durations)
        remaining_epochs = config.epochs - epoch_number
        eta = avg_epoch_duration * remaining_epochs
        tqdm.write(
            " | ".join(
                [
                    f"Epoch {epoch_number}/{config.epochs} done",
                    f"epoch time {format_duration(epoch_duration)}",
                    f"elapsed {format_duration(elapsed_total)}",
                    f"ETA {format_duration(eta)}",
                    f"avg loss {running_loss / max(len(dataloader), 1):.4f}",
                ]
            )
        )
        save_checkpoint(latest_checkpoint, model, optimizer, epoch_number, global_step, config, ema)
        if epoch_number % config.save_every_epochs == 0 or epoch_number == config.epochs:
            save_checkpoint(
                checkpoints_dir / f"epoch_{epoch_number:04d}.pt",
                model,
                optimizer,
                epoch_number,
                global_step,
                config,
                ema,
            )
        if epoch_number % config.sample_every_epochs == 0 or epoch_number == config.epochs:
            ema.apply_to(_unwrap_model(model))
            sample_images = ddpm.sample(
                model,
                image_size=config.image_size,
                batch_size=config.sample_count,
                sample_steps=args.sample_steps,
                sampler=args.sampler,
                ddim_eta=args.ddim_eta,
                timestep_spacing=args.timestep_spacing,
                progress=True,
            )
            grid = make_grid(denormalize(sample_images.cpu()), nrow=int(math.sqrt(config.sample_count)))
            save_image(grid, samples_dir / f"epoch_{epoch_number:04d}.png")
            _unwrap_model(model).load_state_dict(
                torch.load(latest_checkpoint, map_location=device)["model"]
            )

    return latest_checkpoint


def clean_generated_dir(generated_dir: Path) -> None:
    generated_dir.mkdir(parents=True, exist_ok=True)
    for path in generated_dir.iterdir():
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS.union({".pt"}):
            path.unlink()


@torch.no_grad()
def generate(args: argparse.Namespace) -> None:
    seed_everything(args.seed)
    device = resolve_device(args.device)
    checkpoint_path = Path(args.checkpoint)
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint_path}")

    checkpoint = torch.load(checkpoint_path, map_location=device)
    saved_config = checkpoint.get("config", {})
    image_size = int(args.image_size or saved_config.get("image_size", DEFAULT_IMAGE_SIZE))
    timesteps = int(args.timesteps or saved_config.get("timesteps", 1000))
    base_channels = int(args.base_channels or saved_config.get("base_channels", DEFAULT_BASE_CHANNELS))

    generated_dir = Path(args.generated_dir)
    if args.clean_generated:
        clean_generated_dir(generated_dir)
    else:
        generated_dir.mkdir(parents=True, exist_ok=True)

    model = TinyUNet(base_channels=base_channels).to(device)
    model = model.to(memory_format=torch.channels_last)
    if "ema" in checkpoint:
        model.load_state_dict(checkpoint["ema"])
        print("Using EMA weights for generation")
    else:
        model.load_state_dict(checkpoint["model"])
    model.eval()
    if device.type == "cuda":
        model = torch.compile(model)
    ddpm = DDPM(timesteps=timesteps, device=device)

    print(f"Device: {device}")
    print(f"Checkpoint: {checkpoint_path}")
    print(f"Generated dir: {generated_dir}")
    print(f"Generating {args.num_images} images at {image_size}x{image_size}")

    saved_paths: list[Path] = []
    next_index = 1
    with tqdm(total=args.num_images, desc="Generating images") as progress:
        while len(saved_paths) < args.num_images:
            batch_size = min(args.batch_size, args.num_images - len(saved_paths))
            samples = ddpm.sample(
                model,
                image_size=image_size,
                batch_size=batch_size,
                sample_steps=args.sample_steps,
                sampler=args.sampler,
                ddim_eta=args.ddim_eta,
                timestep_spacing=args.timestep_spacing,
                progress=False,
            )
            samples = denormalize(samples.cpu())
            for image in samples:
                out_path = generated_dir / f"generated_{next_index:04d}.png"
                save_image(image, out_path)
                saved_paths.append(out_path)
                next_index += 1
                progress.update(1)

    preview_count = min(64, len(saved_paths))
    if args.save_grid and preview_count > 0:
        preview = torch.stack(
            [
                transforms.ToTensor()(Image.open(path).convert("RGB"))
                for path in saved_paths[:preview_count]
            ]
        )
        save_image(make_grid(preview, nrow=8), generated_dir / "generated_grid.png")
    print(f"Saved {len(saved_paths)} images")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train and sample a DDPM for Assignment3 meteorite images.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    train_parser = subparsers.add_parser("train", help="Train the meteorite DDPM")
    train_parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    train_parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    train_parser.add_argument("--image-size", type=int, default=DEFAULT_IMAGE_SIZE)
    train_parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    train_parser.add_argument("--epochs", type=int, default=1200)
    train_parser.add_argument("--learning-rate", type=float, default=2e-4)
    train_parser.add_argument("--timesteps", type=int, default=1000)
    train_parser.add_argument("--base-channels", type=int, default=DEFAULT_BASE_CHANNELS)
    train_parser.add_argument("--num-workers", type=int, default=4)
    train_parser.add_argument("--save-every-epochs", type=int, default=100)
    train_parser.add_argument("--sample-every-epochs", type=int, default=100)
    train_parser.add_argument("--sample-count", type=int, default=16)
    train_parser.add_argument(
        "--sample-steps",
        type=int,
        default=DEFAULT_SAMPLE_STEPS,
        help="Denoising steps used only for periodic preview samples.",
    )
    train_parser.add_argument(
        "--sampler",
        choices=["auto", "ddpm", "ddim"],
        default=DEFAULT_SAMPLER,
        help="Sampler used only for periodic preview samples.",
    )
    train_parser.add_argument(
        "--ddim-eta",
        type=float,
        default=DEFAULT_DDIM_ETA,
        help="DDIM stochasticity for preview samples. 0.0 is deterministic and smoother.",
    )
    train_parser.add_argument(
        "--timestep-spacing",
        choices=["linear", "quadratic"],
        default=DEFAULT_TIMESTEP_SPACING,
        help="Timestep spacing used by DDIM preview sampling.",
    )
    train_parser.add_argument("--max-train-images", type=int, default=None)
    train_parser.add_argument("--seed", type=int, default=42)
    train_parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    train_parser.add_argument("--resume", type=Path, default=None)
    train_parser.add_argument("--amp", action="store_true", help="Use CUDA automatic mixed precision")
    train_parser.add_argument("--no-augment", action="store_true")
    train_parser.add_argument("--ema-decay", type=float, default=0.9999)

    generate_parser = subparsers.add_parser("generate", help="Generate images from a trained checkpoint")
    generate_parser.add_argument("--checkpoint", type=Path, default=DEFAULT_OUTPUT_DIR / "checkpoints" / "latest.pt")
    generate_parser.add_argument("--generated-dir", type=Path, default=DEFAULT_GENERATED_DIR)
    generate_parser.add_argument("--num-images", type=int, default=1000)
    generate_parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    generate_parser.add_argument("--image-size", type=int, default=None)
    generate_parser.add_argument("--timesteps", type=int, default=None)
    generate_parser.add_argument(
        "--sample-steps",
        type=int,
        default=DEFAULT_GENERATE_SAMPLE_STEPS,
        help="Denoising steps for generation. Use 1000 for best quality (DDPM), fewer for faster DDIM sampling.",
    )
    generate_parser.add_argument(
        "--sampler",
        choices=["auto", "ddpm", "ddim"],
        default=DEFAULT_SAMPLER,
        help="Sampling algorithm. Use ddim with --ddim-eta 0 for smoother deterministic generation.",
    )
    generate_parser.add_argument(
        "--ddim-eta",
        type=float,
        default=DEFAULT_DDIM_ETA,
        help="DDIM stochasticity. 0.0 removes extra sampling noise; larger values add randomness.",
    )
    generate_parser.add_argument(
        "--timestep-spacing",
        choices=["linear", "quadratic"],
        default=DEFAULT_TIMESTEP_SPACING,
        help="Timestep spacing used by DDIM sampling.",
    )
    generate_parser.add_argument("--base-channels", type=int, default=None)
    generate_parser.add_argument("--seed", type=int, default=123)
    generate_parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    generate_parser.add_argument("--clean-generated", action="store_true")
    generate_parser.add_argument(
        "--save-grid",
        action="store_true",
        help="Also save generated_grid.png. Leave off for final evaluation so the folder has exactly 1000 images.",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "train":
        train(args)
    elif args.command == "generate":
        generate(args)
    else:
        raise ValueError(f"Unknown command: {args.command}")


if __name__ == "__main__":
    main()
