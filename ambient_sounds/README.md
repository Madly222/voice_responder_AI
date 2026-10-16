# Ambient Sounds Directory

This directory contains pre-recorded ambient sound files that can be used as background noise in the AVR system. 

## File Format Requirements

All ambient sound files must be in the following format:
- **Sample Rate**: 8kHz
- **Bit Depth**: 16-bit
- **Channels**: Mono
- **Format**: Raw PCM (no headers)

## Creating Ambient Sound Files

### Using SoX

```bash
# Convert using SoX
sox input_file.wav -r 8000 -c 1 -b 16 -e signed output_file.raw
```

## Recommended Ambient Sounds

- **office_background.raw** - Subtle office environment sounds
<!-- - **cafe_ambient.raw** - Coffee shop background noise
- **nature_sounds.raw** - Forest/bird sounds
- **white_noise.raw** - Clean white noise
- **pink_noise.raw** - Natural pink noise
- **air_conditioning.raw** - HVAC system sounds
- **keyboard_typing.raw** - Subtle keyboard sounds
- **rain_ambient.raw** - Rain and thunder sounds -->

## Configuration

To use a specific ambient sound file, set the environment variable:

```bash
AMBIENT_NOISE_FILE=ambient_sounds/office_background.raw
```

## Volume Control

Control the volume of ambient sounds using:

```bash
AMBIENT_NOISE_LEVEL=0.10  # 10% volume
AMBIENT_NOISE_LEVEL=0.50  # 50% volume
AMBIENT_NOISE_LEVEL=0.90  # 90% volume (default)
```