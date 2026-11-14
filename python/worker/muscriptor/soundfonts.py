"""Runtime sources for the MuseScore General soundfonts.

Neither file ships in the package: both are fetched lazily through
:func:`muscriptor.utils.download.download_if_necessary` and cached locally
(``hf://`` URLs land in the HuggingFace hub cache). The upstream origin is
MuseScore's distribution mirror,
https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/, re-hosted
at https://huggingface.co/MuScriptor/assets (MIT license).
"""

# Full soundfont (215 MB), rendered server-side by fluidsynth — the
# /auralize endpoint and the CLI's --auralize flag.
# SHA-256: ee51d2c4b1525e70f19a45909c4fd7a2e26d91d115fa89dbf5a6bc413d8b9bf3
SF2_URL = "hf://MuScriptor/assets/MuseScore_General.sf2"

# Vorbis-compressed build (38 MB) of the same soundfont, served to the web
# UI's in-browser spessasynth_lib synthesizer (GET /soundfonts/…).
# SHA-256: 5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3
SF3_URL = "hf://MuScriptor/assets/MuseScore_General.sf3"
