#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // empty')
MODEL_ID=$(echo "$input" | jq -r '.model.id // empty')
EFFORT=$(echo "$input" | jq -r '.effort_level // .effortLevel // (if (.effort | type) == "object" then .effort.level elif (.effort | type) == "string" then .effort else empty end) // .model.effort_level // .model.effort // empty')
ULTRACODE=$(echo "$input" | jq -r '.ultracode // (if (.effort | type) == "object" then (.effort.ultracode // .effort.is_ultracode) else false end) // .session.ultracode // false')
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

CYAN='\033[38;2;34;229;238m'
GREEN='\033[38;2;63;185;80m'
AMBER='\033[38;2;210;153;34m'
RED='\033[38;2;248;81;73m'
BLUE='\033[38;2;88;166;255m'
PURPLE='\033[38;2;166;108;255m'
GRAY='\033[38;2;139;148;158m'
SEP='\033[38;2;72;79;88m'
EMPTY_BAR='\033[38;2;48;54;61m'
RESET='\033[0m'

color_for_pct() {
    local pct="${1:-0}"
    if ! [[ "$pct" =~ ^[0-9]+$ ]]; then pct=0; fi
    if [ "$pct" -ge 90 ]; then printf "%b" "$RED"
    elif [ "$pct" -ge 75 ]; then printf "%b" "$AMBER"
    else printf "%b" "$GREEN"; fi
}

repeat_char() {
    local count="${1:-0}" char="${2:-█}" out=""
    while [ "$count" -gt 0 ]; do
        out="${out}${char}"
        count=$((count - 1))
    done
    printf "%s" "$out"
}

usage_bar() {
    local pct="${1:-0}" width="${2:-10}" fill_color="${3:-$GREEN}" style="${4:-block}"
    if ! [[ "$pct" =~ ^[0-9]+$ ]]; then pct=0; fi
    [ "$pct" -lt 0 ] && pct=0
    [ "$pct" -gt 100 ] && pct=100
    local filled=$(( (pct * width + 99) / 100 ))
    [ "$pct" -gt 0 ] && [ "$filled" -lt 1 ] && filled=1
    [ "$filled" -gt "$width" ] && filled="$width"
    local empty=$(( width - filled ))
    local fill_glyph="█" empty_glyph="░"
    if [ "$style" = "compact" ]; then
        fill_glyph="▰"
        empty_glyph="▱"
    fi
    local filled_text="" empty_text=""
    [ "$filled" -gt 0 ] && filled_text=$(repeat_char "$filled" "$fill_glyph")
    [ "$empty" -gt 0 ] && empty_text=$(repeat_char "$empty" "$empty_glyph")
    printf "%b%s%b%s%b" "$fill_color" "$filled_text" "$EMPTY_BAR" "$empty_text" "$RESET"
}

terminal_cols() {
    local cols=""
    if [[ "${COLUMNS:-}" =~ ^[0-9]+$ ]] && [ "$COLUMNS" -gt 0 ]; then
        echo "$COLUMNS"
        return
    fi
    cols=$(stty size </dev/tty 2>/dev/null | awk '{print $2}')
    if [[ "$cols" =~ ^[0-9]+$ ]] && [ "$cols" -gt 0 ]; then
        echo "$cols"
        return
    fi
    cols=$(tput cols 2>/dev/null)
    if [[ "$cols" =~ ^[0-9]+$ ]] && [ "$cols" -gt 0 ]; then
        echo "$cols"
        return
    fi
    echo 120
}

week_reset_label() {
    local seconds="${1:-}"
    if ! [[ "$seconds" =~ ^-?[0-9]+$ ]]; then return; fi
    [ "$seconds" -lt 0 ] && seconds=0
    if [ "$seconds" -ge 86400 ]; then
        # floor days + floor remainder hours, so 5d12h reads as "5d12h" not "6d"
        local days=$(( seconds / 86400 ))
        local hours=$(( (seconds % 86400) / 3600 ))
        if [ "$hours" -gt 0 ]; then
            printf "↻%dd%dh" "$days" "$hours"
        else
            printf "↻%dd" "$days"
        fi
    elif [ "$seconds" -ge 3600 ]; then
        local hours=$(( (seconds + 3599) / 3600 ))
        [ "$hours" -lt 1 ] && hours=1
        printf "↻%dh" "$hours"
    else
        local mins=$(( (seconds + 59) / 60 ))
        [ "$mins" -lt 1 ] && mins=1
        printf "↻%dm" "$mins"
    fi
}

duration_label() {
    local seconds="${1:-}" hours=0 mins=0
    if ! [[ "$seconds" =~ ^-?[0-9]+$ ]]; then return; fi
    [ "$seconds" -lt 0 ] && seconds=0
    if [ "$seconds" -ge 3600 ]; then
        hours=$((seconds / 3600))
        mins=$(((seconds % 3600 + 59) / 60))
        if [ "$mins" -eq 60 ]; then
            hours=$((hours + 1))
            mins=0
        fi
        printf "%dh%dm" "$hours" "$mins"
    else
        mins=$(((seconds + 59) / 60))
        [ "$mins" -lt 1 ] && mins=1
        printf "%dm" "$mins"
    fi
}

short_model_label() {
    local raw="${1:-}" id="${2:-}" label=""
    if [ -n "$raw" ] && [ "$raw" != "null" ]; then
        label=$(printf "%s" "$raw" \
            | sed -E 's/[[:space:]]*\([^)]*\)//g; s/^[Cc]laude[[:space:]]+//; s/[[:space:]]+//g' \
            | tr '[:upper:]' '[:lower:]')
    fi
    if [ -z "$label" ] && [[ "$id" =~ (opus|sonnet|haiku)[^0-9]*([0-9]+)[.-]([0-9]+) ]]; then
        label="${BASH_REMATCH[1]}${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
    fi
    [ -z "$label" ] && label="model"
    printf "%s" "$label"
}

effort_label() {
    local effort="${1:-}" ultracode="${2:-false}"
    if [ -z "$effort" ] || [ "$effort" = "null" ]; then
        effort=$(jq -r '.effortLevel // .env.CLAUDE_EFFORT // empty' "$HOME/.claude/settings.json" 2>/dev/null)
    fi
    effort=$(printf "%s" "$effort" | tr '[:upper:]' '[:lower:]')
    if [ "$effort" = "ultracode" ]; then
        printf "xhigh-ultra"
        return
    fi
    if [ "$ultracode" = "true" ] && { [ -z "$effort" ] || [ "$effort" = "xhigh" ]; }; then
        printf "xhigh-ultra"
        return
    fi
    case "$effort" in
        low|medium|high|xhigh|max) printf "%s" "$effort" ;;
        *) printf "" ;;
    esac
}

effort_color() {
    case "${1:-}" in
        low) printf "%b" "$AMBER" ;;
        medium) printf "%b" "$GREEN" ;;
        high) printf "%b" "$BLUE" ;;
        xhigh|xhigh-ultra) printf "%b" "$PURPLE" ;;
        max) printf "%b" "$RED" ;;
        *) printf "%b" "$BLUE" ;;
    esac
}

BAR_COLOR=$(color_for_pct "$PCT")
SESSION_BAR_WIDTH=10
BAR=$(usage_bar "$PCT" "$SESSION_BAR_WIDTH" "$BAR_COLOR")
MODEL_LABEL=$(short_model_label "$MODEL" "$MODEL_ID")
EFFORT_LABEL=$(effort_label "$EFFORT" "$ULTRACODE")
EFFORT_COLOR=$(effort_color "$EFFORT_LABEL")
MODEL_SEGMENT="${CYAN}${MODEL_LABEL}${RESET}"
[ -n "$EFFORT_LABEL" ] && MODEL_SEGMENT="${MODEL_SEGMENT} ${SEP}|${RESET} ${EFFORT_COLOR}${EFFORT_LABEL}${RESET}"

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"

short_tokens() {
    local n="${1:-0}"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then printf "?"; return; fi
    if [ "$n" -ge 1000000 ]; then printf "%d.%dM" $((n / 1000000)) $(((n % 1000000) / 100000))
    elif [ "$n" -ge 1000 ]; then printf "%dk" $(((n + 500) / 1000))
    else printf "%d" "$n"; fi
}

# ── Prompt cache (Claude Code's own prompt_cache object, v2.1.251+) ──────────
# Shows the expiry as a clock time, not a countdown: without refreshInterval the
# script only re-runs on events, so a countdown would freeze while idle. Claude
# Code re-runs the script at expires_at, which flips the segment to cold.
CACHE_SEG=""
IFS='|' read -r PC_PRESENT PC_OBSERVED PC_WARM PC_TTL PC_EXP PC_HIT PC_MISSES PC_COLD <<< "$(echo "$input" | jq -r '
    .prompt_cache as $p
    | if $p == null then "no"
      else ["yes", ($p.caching_observed // false), ($p.warm // false), ($p.ttl // ""),
            ($p.expires_at // ""), (if $p.hit_ratio == null then "" else ($p.hit_ratio * 100 | floor) end),
            ($p.misses // 0), ($p.recache_tokens_if_cold // "")] | map(tostring) | join("|")
      end' 2>/dev/null)"
if [ "$PC_PRESENT" = "yes" ]; then
    if [ "$PC_OBSERVED" != "true" ]; then
        CACHE_SEG="${GRAY}cache off${RESET}"
    elif [ "$PC_WARM" = "true" ]; then
        HIT_COLOR="$GREEN"
        if [[ "$PC_HIT" =~ ^[0-9]+$ ]]; then
            [ "$PC_HIT" -lt 80 ] && HIT_COLOR="$AMBER"
            [ "$PC_HIT" -lt 50 ] && HIT_COLOR="$RED"
        fi
        CACHE_SEG="${GRAY}cache${RESET}"
        [ -n "$PC_HIT" ] && CACHE_SEG="${CACHE_SEG} ${HIT_COLOR}${PC_HIT}%${RESET}"
        [ -n "$PC_TTL" ] && CACHE_SEG="${CACHE_SEG} ${GRAY}${PC_TTL}${RESET}"
        if [[ "$PC_EXP" =~ ^[0-9]+$ ]]; then
            CACHE_SEG="${CACHE_SEG} ${BLUE}→$(date -r "$PC_EXP" +%H:%M 2>/dev/null)${RESET}"
        fi
    else
        COLD_COLOR="$AMBER"
        [[ "$PC_COLD" =~ ^[0-9]+$ ]] && [ "$PC_COLD" -ge 100000 ] && COLD_COLOR="$RED"
        CACHE_SEG="${GRAY}cache${RESET} ${COLD_COLOR}cold${RESET}"
        [ -n "$PC_COLD" ] && CACHE_SEG="${CACHE_SEG} ${COLD_COLOR}rewrite $(short_tokens "$PC_COLD")${RESET}"
    fi
    if [ -n "$CACHE_SEG" ] && [[ "$PC_MISSES" =~ ^[0-9]+$ ]] && [ "$PC_MISSES" -gt 0 ]; then
        CACHE_SEG="${CACHE_SEG} ${AMBER}${PC_MISSES} miss${RESET}"
    fi
    CACHE_SEG=" ${SEP}|${RESET} ${CACHE_SEG}"
fi

# Context monitor bridge — write metrics for PostToolUse hook to read
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')
if [ -n "$SESSION_ID" ]; then
    printf '{"pct":%d,"ts":%d}' "$PCT" "$(date +%s)" > "/tmp/claude-ctx-${SESSION_ID}.json" 2>/dev/null
fi

NOW=$(date +%s)

# ── Live Claude Code usage gauge (OAuth cache, no API key) ────────────────
# Reads the sanitized cache written by scripts/usage-live.py. If the cache is
# missing or >5 min stale, try a bounded refresh before rendering. The refresher
# reads Claude Code's OAuth credential and never stores the bearer token.
LIVE="$HOME/.claude/usage-live.json"
LIVE_REFRESHER="$HOME/.claude/scripts/usage-live.py"
LIVE_AGE=99999
[ -f "$LIVE" ] && LIVE_AGE=$(( NOW - $(stat -f %m "$LIVE" 2>/dev/null || echo 0) ))
LIVE_RESET_REFRESH=false
if [ -f "$LIVE" ]; then
    LIVE_FH_PCT=$(jq -r '.five_hour.pct // empty' "$LIVE" 2>/dev/null | cut -d. -f1)
    LIVE_FH_RESET_UTC=$(jq -r '.five_hour.resets_at_utc // empty' "$LIVE" 2>/dev/null)
    LIVE_LAST_REFRESH_ERROR=$(jq -r '.last_refresh_error.generated_at // empty' "$LIVE" 2>/dev/null)
    NOW_UTC=$(date -u '+%Y-%m-%dT%H:%M:%S+00:00')
    case "$LIVE_FH_RESET_UTC" in
        ????-??-??T??:??:??+00:00)
            if [[ "$LIVE_FH_PCT" =~ ^[0-9]+$ ]] \
                && [ "$LIVE_FH_PCT" -ge 100 ] \
                && { [ -z "$LIVE_LAST_REFRESH_ERROR" ] || [ "$LIVE_AGE" -ge 30 ]; } \
                && [[ "$NOW_UTC" == "$LIVE_FH_RESET_UTC" || "$NOW_UTC" > "$LIVE_FH_RESET_UTC" ]]; then
                # A full window can reset inside the normal five-minute cache TTL. Refresh on
                # the first redraw after the absolute reset time instead of showing 100% / 1m.
                # A recorded refresh error plus the cache mtime provides a small retry backoff.
                LIVE_RESET_REFRESH=true
            fi
            ;;
    esac
fi
if { [ "$LIVE_AGE" -gt 300 ] || [ "$LIVE_RESET_REFRESH" = true ]; } \
    && [ -x "$LIVE_REFRESHER" ]; then
    python3 "$LIVE_REFRESHER" --quiet --force --http-timeout-seconds 1.5 >/dev/null 2>&1 || true
    NOW=$(date +%s)
    [ -f "$LIVE" ] && LIVE_AGE=$(( NOW - $(stat -f %m "$LIVE" 2>/dev/null || echo 0) ))
fi
GAUGE=""
USAGE_WEEK=""
if [ -f "$LIVE" ]; then
    LOK=$(jq -r '.ok // false' "$LIVE" 2>/dev/null)
    FHPCT=$(jq -r '.five_hour.pct // empty' "$LIVE" 2>/dev/null | cut -d. -f1)
    FHREM=$(jq -r '.five_hour.resets_in // empty' "$LIVE" 2>/dev/null)
    FHSEC=$(jq -r '.five_hour.resets_in_seconds // empty' "$LIVE" 2>/dev/null | cut -d. -f1)
    WPCT=$(jq -r '.seven_day.pct // empty' "$LIVE" 2>/dev/null | cut -d. -f1)
    WSEC=$(jq -r '.seven_day.resets_in_seconds // empty' "$LIVE" 2>/dev/null | cut -d. -f1)
    WRESET_SEC="$WSEC"
    # Model-scoped weekly cap (currently Fable). The OAuth usage endpoint reports it
    # only inside limits[] as kind=weekly_scoped; seven_day_<model> stays null for it.
    MODEL_MATCH=$(printf '%s %s' "$MODEL" "$MODEL_ID" | tr '[:upper:]' '[:lower:]')
    SCOPED=$(jq -r --arg m "$MODEL_MATCH" '
        (.scoped_limits // [])
        | map(select((.model_key // "") as $k | ($k != "") and ($m | contains($k))))
        | sort_by(-(.pct // 0))
        | .[0] // empty
        | [(.model // ""), (.pct // ""), (.resets_in_seconds // "")]
        | @tsv' "$LIVE" 2>/dev/null)
    if [ "$LOK" = "true" ] && [ -n "$FHPCT" ] && [ "$FHPCT" != "null" ]; then
        TERM_COLS=$(terminal_cols)
        FH_COLOR=$(color_for_pct "$FHPCT")
        W_COLOR=$(color_for_pct "$WPCT")
        FH_LEFT=""; [ -n "$FHREM" ] && [ "$FHREM" != "null" ] && FH_LEFT="↻${FHREM}"
        W_LEFT=$(week_reset_label "$WSEC")
        FH_COMPACT=$(duration_label "$FHSEC")
        [ -z "$FH_COMPACT" ] && FH_COMPACT="${FH_LEFT#↻}"
        W_COMPACT="${W_LEFT#↻}"
        SCOPED_SEG=""
        if [ -n "$SCOPED" ]; then
            SC_MODEL=$(printf '%s' "$SCOPED" | cut -f1 | tr '[:upper:]' '[:lower:]')
            SC_PCT=$(printf '%s' "$SCOPED" | cut -f2 | cut -d. -f1)
            SC_SEC=$(printf '%s' "$SCOPED" | cut -f3 | cut -d. -f1)
            if [[ "$SC_PCT" =~ ^[0-9]+$ ]]; then
                SC_COLOR=$(color_for_pct "$SC_PCT")
                SCOPED_SEG="${GRAY}${SC_MODEL} wk${RESET} $(usage_bar "$SC_PCT" 4 "$SC_COLOR" compact) ${SC_COLOR}${SC_PCT}%${RESET}"
                # The scoped window almost always resets with the all-model week, and the
                # endpoint jitters that timestamp by a second. Only print it when it really
                # differs, so the line does not carry the same reset twice.
                if [[ "$SC_SEC" =~ ^-?[0-9]+$ ]]; then
                    SC_DELTA=0
                    if [[ "$WRESET_SEC" =~ ^-?[0-9]+$ ]]; then
                        SC_DELTA=$(( SC_SEC - WRESET_SEC ))
                        [ "$SC_DELTA" -lt 0 ] && SC_DELTA=$(( -SC_DELTA ))
                    else
                        SC_DELTA=99999
                    fi
                    if [ "$SC_DELTA" -gt 300 ]; then
                        SC_COMPACT=$(week_reset_label "$SC_SEC")
                        [ -n "$SC_COMPACT" ] && SCOPED_SEG="${SCOPED_SEG} ${BLUE}${SC_COMPACT#↻}${RESET}"
                    fi
                fi
            fi
        fi
        if [ "$TERM_COLS" -ge 50 ] && [ -n "$WPCT" ] && [ "$WPCT" != "null" ]; then
            SESSION_BAR_WIDTH=4
            BAR=$(usage_bar "$PCT" "$SESSION_BAR_WIDTH" "$BAR_COLOR" compact)
            GAUGE=" ${SEP}|${RESET} ${GRAY}5h${RESET} $(usage_bar "$FHPCT" 4 "$FH_COLOR" compact) ${FH_COLOR}${FHPCT}%${RESET}"
            [ -n "$FH_COMPACT" ] && GAUGE="${GAUGE} ${BLUE}${FH_COMPACT}${RESET}"
            GAUGE="${GAUGE} ${SEP}|${RESET} ${GRAY}wk${RESET} $(usage_bar "$WPCT" 4 "$W_COLOR" compact) ${W_COLOR}${WPCT}%${RESET}"
            [ -n "$W_COMPACT" ] && GAUGE="${GAUGE} ${BLUE}${W_COMPACT}${RESET}"
            [ -n "$SCOPED_SEG" ] && GAUGE="${GAUGE} ${SEP}|${RESET} ${SCOPED_SEG}"
        else
            SESSION_BAR_WIDTH=4
            BAR=$(usage_bar "$PCT" "$SESSION_BAR_WIDTH" "$BAR_COLOR" compact)
            GAUGE=" ${SEP}|${RESET} ${GRAY}5h${RESET} $(usage_bar "$FHPCT" 4 "$FH_COLOR" compact) ${FH_COLOR}${FHPCT}%${RESET}"
            [ -n "$FH_COMPACT" ] && GAUGE="${GAUGE} ${BLUE}${FH_COMPACT}${RESET}"
            if [ -n "$WPCT" ] && [ "$WPCT" != "null" ]; then
                USAGE_WEEK="${GRAY}limits:${RESET} ${GRAY}wk${RESET} $(usage_bar "$WPCT" 4 "$W_COLOR" compact) ${W_COLOR}${WPCT}%${RESET}"
                [ -n "$W_COMPACT" ] && USAGE_WEEK="${USAGE_WEEK} ${BLUE}${W_COMPACT}${RESET}"
            fi
            if [ -n "$SCOPED_SEG" ]; then
                if [ -n "$USAGE_WEEK" ]; then
                    USAGE_WEEK="${USAGE_WEEK} ${SEP}|${RESET} ${SCOPED_SEG}"
                else
                    USAGE_WEEK="${GRAY}limits:${RESET} ${SCOPED_SEG}"
                fi
            fi
        fi
        [ "$LIVE_AGE" -gt 600 ] && GAUGE="${GAUGE} ${AMBER}stale${RESET}"
    fi
fi

# ── Opus weekly-budget gauge (local, no-API fallback) ─────────────────────
# Reads the cached snapshot written by scripts/usage-snapshot.sh. If the snapshot
# is missing or >10 min stale, kick a background refresh (non-blocking) so the
# next render is fresh. Never calls an API; never blocks; degrades to no segment.
SNAP="$HOME/.claude/usage-snapshot.json"
REFRESHER="$HOME/.claude/scripts/usage-snapshot.sh"
SNAP_AGE=99999
[ -f "$SNAP" ] && SNAP_AGE=$(( NOW - $(stat -f %m "$SNAP" 2>/dev/null || echo 0) ))
if [ "$SNAP_AGE" -gt 600 ] && [ -x "$REFRESHER" ]; then
    ( python3 "$REFRESHER" >/dev/null 2>&1 & ) >/dev/null 2>&1
fi
if [ -z "$GAUGE" ] && [ -f "$SNAP" ]; then
    OPCT=$(jq -r '.pct // empty' "$SNAP" 2>/dev/null)
    ODR=$(jq -r '.days_to_reset // empty' "$SNAP" 2>/dev/null)
    NH=$(jq -r '.is_new_high // false' "$SNAP" 2>/dev/null)
    if [ -n "$OPCT" ] && [ "$OPCT" != "null" ]; then
        # pct = this billing week's Opus burn vs your busiest week ever (self-raising ceiling)
        GC=$(color_for_pct "$OPCT")
        STAR=""; [ "$NH" = "true" ] && STAR="★"      # new all-time-high week
        DR_STR=""; [ -n "$ODR" ] && [ "$ODR" != "null" ] && DR_STR=" ·↻${ODR}d"
        GAUGE=" | ${GC}🔋 Opus ${STAR}${OPCT}%${DR_STR}${RESET}"
        [ "$SNAP_AGE" -gt 900 ] && GAUGE="${GAUGE} ${AMBER}stale${RESET}"
    fi
fi

echo -e "${MODEL_SEGMENT} ${SEP}|${RESET} 📁 ${DIR##*/}$BRANCH$CACHE_SEG"
echo -e "${BAR} ${BAR_COLOR}${PCT}%${RESET}${GAUGE}"
[ -n "$USAGE_WEEK" ] && echo -e "$USAGE_WEEK"
exit 0
