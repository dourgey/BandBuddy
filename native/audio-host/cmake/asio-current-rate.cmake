# RtAudio 6.0.1 only populates currentSampleRate for CoreAudio. ASIO's
# preferredSampleRate is inferred from supported rates, not the device clock.
# Read the clock while the driver is already open for enumeration so automatic
# session setup need not change a clock also used by Windows/browser playback.
file(READ "${rtaudio_SOURCE_DIR}/RtAudio.cpp" rtaudio_source)
set(rate_marker "// BandBuddy: preserve the current ASIO device clock.")
string(FIND "${rtaudio_source}" "${rate_marker}" already_patched)
if(already_patched EQUAL -1)
  set(rate_anchor "  // Determine supported data types ... just check first channel and assume rest are the same.")
  string(FIND "${rtaudio_source}" "${rate_anchor}" anchor_position)
  if(anchor_position EQUAL -1)
    message(FATAL_ERROR "RtAudio ASIO current-rate patch no longer matches the pinned source")
  endif()
  set(rate_patch "  ${rate_marker}
  ASIOSampleRate currentRate = 0;
  if ( ASIOGetSampleRate( &currentRate ) == ASE_OK && currentRate >= 8000 && currentRate <= 192000 )
    info.currentSampleRate = static_cast<unsigned int>( currentRate + 0.5 );

${rate_anchor}")
  string(REPLACE "${rate_anchor}" "${rate_patch}" rtaudio_source "${rtaudio_source}")
  file(WRITE "${rtaudio_SOURCE_DIR}/RtAudio.cpp" "${rtaudio_source}")
endif()
