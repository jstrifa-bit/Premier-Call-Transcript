# Premier Call Transcript Analyzer - backend server
# PowerShell 5.1, no external dependencies. Serves static files + JSON API.
# Source must be ASCII-only (PS 5.1 reads UTF-8-without-BOM as Windows-1252).

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

# --- .env loader ----------------------------------------------------------------
function Load-DotEnv {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return @{} }
    $bag = @{}
    foreach ($line in (Get-Content $Path -Encoding UTF8)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith("#")) { continue }
        $eq = $t.IndexOf("=")
        if ($eq -lt 1) { continue }
        $k = $t.Substring(0, $eq).Trim()
        $v = $t.Substring($eq + 1).Trim()
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
        $bag[$k] = $v
    }
    return $bag
}

$envBag = Load-DotEnv -Path (Join-Path $ScriptDir ".env")
$AnthropicKey   = $envBag["ANTHROPIC_API_KEY"]
$AnthropicModel = if ($envBag["ANTHROPIC_MODEL"]) { $envBag["ANTHROPIC_MODEL"] } else { "claude-sonnet-4-6" }
$GeminiKey      = $envBag["GEMINI_API_KEY"]
$GeminiModel    = if ($envBag["GEMINI_MODEL"]) { $envBag["GEMINI_MODEL"] } else { "gemini-2.0-flash" }
$Port           = if ($envBag["PORT"]) { [int]$envBag["PORT"] } else { 4321 }

# --- data loaders ---------------------------------------------------------------
function Get-Sops {
    $path = Join-Path $ScriptDir "sops.json"
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Save-Sops {
    param($Doc)
    $path = Join-Path $ScriptDir "sops.json"
    $json = $Doc | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($path, $json, [System.Text.Encoding]::UTF8)
}

function Get-Crm {
    $path = Join-Path $ScriptDir "crm.json"
    return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

# --- helpers --------------------------------------------------------------------
function Read-RequestBody {
    param($Request)
    if (-not $Request.HasEntityBody) { return "" }
    $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Close() }
}

function Write-Json {
    param($Response, $Obj, [int]$Status = 200)
    $Response.StatusCode = $Status
    $Response.ContentType = "application/json; charset=utf-8"
    $json = $Obj | ConvertTo-Json -Depth 20
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Write-Text {
    param($Response, [string]$Body, [string]$ContentType = "text/plain; charset=utf-8", [int]$Status = 200)
    $Response.StatusCode = $Status
    $Response.ContentType = $ContentType
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Write-Static {
    param($Response, [string]$Path)
    if (-not (Test-Path $Path)) {
        Write-Text $Response "Not Found" "text/plain; charset=utf-8" 404
        return
    }
    $ext = [System.IO.Path]::GetExtension($Path).ToLower()
    $mime = switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".svg"  { "image/svg+xml" }
        ".png"  { "image/png" }
        ".ico"  { "image/x-icon" }
        default { "application/octet-stream" }
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $Response.StatusCode = 200
    $Response.ContentType = $mime
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

# --- disposition ordering -------------------------------------------------------
# Mirrors sops.json status_priority. "Cleared" is internal-only (no SOPs in v2 emit it).
$STATUS_PRIORITY = @{
    "Ineligible"        = 1
    "Deferred"          = 2
    "High Complexity"   = 3
    "Review"            = 4
    "Revision Case"     = 5
    "Hold"              = 6
    "Action Required"   = 7
    "Cleared"           = 99
}

function Get-OverallDisposition {
    param($Findings)
    if (-not $Findings -or $Findings.Count -eq 0) {
        return @{ status = "Cleared"; reason = "No SOP triggers detected" }
    }
    $sorted = $Findings | Sort-Object { $STATUS_PRIORITY[$_.status] }
    $top = $sorted[0]
    return @{ status = $top.status; reason = "Driven by $($top.sop_id): $($top.finding)" }
}

# --- CRM matchers ---------------------------------------------------------------
function Get-CrmByQuery {
    param([string]$Name, [string]$PatientId)
    $crm = Get-Crm
    $nameLower = if ($Name) { $Name.Trim().ToLower() } else { "" }
    $idTrim = if ($PatientId) { $PatientId.Trim() } else { "" }
    foreach ($r in $crm.records) {
        if ($idTrim -and $r.patient_id -ieq $idTrim) { return $r }
    }
    if ($nameLower) {
        foreach ($r in $crm.records) {
            foreach ($alias in $r.name_aliases) {
                if ($alias.ToLower() -eq $nameLower) { return $r }
                if ($nameLower.Contains($alias.ToLower())) { return $r }
            }
        }
    }
    return $null
}

function Get-CrmFromTranscript {
    param([string]$Transcript)
    if (-not $Transcript) { return $null }
    $lc = $Transcript.ToLower()
    $crm = Get-Crm
    foreach ($r in $crm.records) {
        foreach ($alias in $r.name_aliases) {
            if ($lc.Contains($alias.ToLower())) { return $r }
        }
    }
    return $null
}

# --- local heuristic analysis ---------------------------------------------------
function Find-A1cValue {
    param([string]$Text)
    $rx = [regex]"(?i)(?:hba1c|a1c)[^\d%]{0,12}(\d+(?:\.\d+)?)\s*%?"
    $m = $rx.Match($Text)
    if ($m.Success) { return [double]$m.Groups[1].Value }
    return $null
}

function Has-Match {
    param([string]$Text, [string[]]$Patterns)
    foreach ($p in $Patterns) {
        if ($Text -match $p) { return $true }
    }
    return $false
}

function Invoke-LocalAnalysis {
    param([string]$Transcript, $CrmRecord)
    $sops = (Get-Sops).rules
    $lc = $Transcript.ToLower()
    $findings = @()

    $caseType = if ($CrmRecord) { $CrmRecord.case_type } else { "" }
    $caseTypeLower = $caseType.ToLower()

    foreach ($sop in $sops) {
        # Gate by applies_to. Compare case-insensitively against $sop.applies_to.
        $applies = $false
        if ($sop.applies_to) {
            foreach ($at in $sop.applies_to) {
                if ($at.ToLower() -eq $caseTypeLower) { $applies = $true; break }
            }
        }
        if (-not $applies) { continue }

        $hit = $false
        $detail = ""

        switch ($sop.id) {
            "GEN-001" {
                # Dental clearance. Fire only when dental concern raised AND no recent clearance.
                $dentalRaised = Has-Match $lc @("dental","\bteeth\b","\bcavity\b","\babscess\b","\bgum\b","pending dental")
                if ($dentalRaised) {
                    $recentClearance = Has-Match $lc @("dental clearance","dental exam (last|this|recent)","cleared by (the )?dentist","dentist (last|this) (week|month)","saw the dentist (last|this) (week|month)")
                    $pendingWork = Has-Match $lc @("pending dental","need(s|ed)? dental","dental work (still |is )?(pending|outstanding)")
                    if (-not $recentClearance -or $pendingWork) { $hit = $true; $detail = "Dental concern raised; clearance not documented within 6 months" }
                }
            }
            "JNT-001" {
                $smokes = Has-Match $lc @("\bsmok(e|ing|er)\b","cigarette","\bvape\b|vaping","nicotine","tobacco","pack a day","half a pack")
                $quitRecent = Has-Match $lc @("quit (last|this) (week|month)","quit (\d+) (weeks?|months?) ago","stopped smoking (\d+) (weeks?|months?) ago","just quit","recently quit")
                $quitClean = Has-Match $lc @("quit (\d+ )?years? ago","haven'?t smoked in (\d+ )?years","stopped smoking (\d+ )?years ago")
                if (($smokes -and -not $quitClean) -or $quitRecent) { $hit = $true; $detail = "Active smoker or recent quit (<3 months)" }
            }
            "JNT-002" {
                $ptRaised = Has-Match $lc @("physical therapy","\bpt\b","conservative therapy","exercise program")
                if ($ptRaised) {
                    $completedPt = Has-Match $lc @("completed (a |the )?(course of )?(supervised )?pt","pt for (\d+) weeks","six weeks of pt","finished physical therapy","completed physical therapy","did (a course of )?pt")
                    $noAttempt = Has-Match $lc @("never did (real )?pt","didn'?t do (real )?pt","no pt","honestly no","haven'?t done pt","tried (the )?gym","gym (sessions?|a couple)","couple of times")
                    if (-not $completedPt -and $noAttempt) { $hit = $true; $detail = "No documented attempt at supervised PT" }
                }
            }
            "JNT-003" {
                $a1c = Find-A1cValue -Text $Transcript
                if ($a1c -and $a1c -gt 7.0) { $hit = $true; $detail = "HbA1c $a1c exceeds 7.0 threshold" }
            }
            "JNT-004" {
                $opioidMention = Has-Match $lc @("opioid","oxycodone","hydrocodone","tramadol","morphine","percocet","vicodin","norco")
                $daily = Has-Match $lc @("every day","daily","chronic","long.?term")
                $duration = Has-Match $lc @("for (\d+ )?(months|years)","(\d+) months","(\d+) years")
                if ($opioidMention -and $daily -and $duration) { $hit = $true; $detail = "Daily opioid use exceeding 3 months indicated" }
            }
            "BAR-001" {
                if (Has-Match $lc @("gastric bypass","sleeve gastrectomy","\bsleeve\b","lap.?band","prior bariatric","previous bariatric","had (a |the )?(bypass|sleeve)","prior weight.?loss surgery")) {
                    $hit = $true; $detail = "Prior weight-loss surgery mentioned"
                }
            }
            "BAR-002" {
                $egdRaised = Has-Match $lc @("\begd\b","upper endoscopy","esophagogastroduoden","endoscopy")
                if ($egdRaised) {
                    $negation = Has-Match $lc @("no one (has )?ordered","haven'?t had","hasn'?t had","not yet","not ordered","no one's ordered","none yet","no endoscopy")
                    $recent = Has-Match $lc @("egd (last|this) (week|month)","endoscopy (last|this) (week|month)","completed (an |the )?egd","had (an |the )?egd (\d+ )?(weeks?|months?) ago")
                    if ($negation -and -not $recent) { $hit = $true; $detail = "No EGD within last 3 months" }
                }
            }
            "BAR-003" {
                $rdRaised = Has-Match $lc @("registered dietitian","registered dietician","\brd\b","dietitian","dietician","nutrition")
                if ($rdRaised) {
                    $hasRd = Has-Match $lc @("my (registered )?dietitian","my (registered )?dietician","working with (a |an |my )?(registered )?dietitian","working with (a |an |my )?(registered )?dietician","saw (my |an )?(registered )?dietitian (last|this) (week|month)")
                    $nutritionistOnly = Has-Match $lc @("nutritionist (once|one time)","saw a nutritionist","met with (a |the )?nutritionist","that'?s it")
                    $missing = Has-Match $lc @("haven'?t (seen|met)","never (seen|met) (a |an |the )?(rd|dietitian|dietician)","no dietitian","no dietician")
                    if (-not $hasRd -and ($nutritionistOnly -or $missing)) { $hit = $true; $detail = "No registered dietitian identified" }
                }
            }
        }

        if ($hit) {
            $findings += [pscustomobject]@{
                sop_id    = $sop.id
                title     = $sop.finding
                category  = $sop.category
                finding   = if ($detail) { $detail } else { $sop.finding }
                status    = $sop.case_status
                action    = $sop.action
                evidence  = $detail
            }
        }
    }

    $disposition = Get-OverallDisposition -Findings $findings
    $patientSummary = Build-LocalSummary -Crm $CrmRecord -Findings $findings -Transcript $Transcript
    $recommendation = Build-LocalRecommendation -Findings $findings -Disposition $disposition
    $nextSteps = Build-LocalNextSteps -Findings $findings -Disposition $disposition

    return [pscustomobject]@{
        engine              = "local"
        model               = "heuristic-v1"
        patient_summary     = $patientSummary
        recommendation      = $recommendation
        findings            = $findings
        overall_disposition = $disposition
        next_steps          = $nextSteps
    }
}

function Build-LocalSummary {
    param($Crm, $Findings, [string]$Transcript)
    # Summary is grounded in the transcript only; CRM is intentionally not referenced.
    $sentences = @()
    if ($Findings -and $Findings.Count -gt 0) {
        $topics = @()
        foreach ($f in $Findings) {
            if ($f.evidence) { $topics += $f.evidence } else { $topics += $f.finding }
        }
        $sentences += "Key clinical points raised in the call: " + ($topics -join "; ") + "."
    } else {
        $sentences += "No SOP triggers were detected in this call."
    }
    $a1c = Find-A1cValue -Text $Transcript
    if ($a1c) { $sentences += "Most recent HbA1c referenced: $a1c." }
    if ($Findings.Count -ge 2) {
        $sentences += "Multiple workup gaps were identified - see the SOP findings below for the full list."
    } else {
        $sentences += "Disposition is driven by the findings detailed below."
    }
    return ($sentences -join " ")
}

function Build-LocalRecommendation {
    param($Findings, $Disposition)
    if (-not $Findings -or $Findings.Count -eq 0) {
        return "No SOP triggers were detected. Recommend proceeding to surgical consultation scheduling per the standard pathway."
    }
    $sorted = $Findings | Sort-Object { $STATUS_PRIORITY[$_.status] }
    $top = $sorted[0]
    $ids = ($sorted | ForEach-Object { $_.sop_id }) -join ", "
    $line1 = "Recommended disposition: $($Disposition.status). This is driven by $($top.sop_id) ($($top.title)) - $($top.finding.ToLower())."
    $line2 = if ($Findings.Count -gt 1) { "Additional SOPs in play: $ids. Each requires the action listed in its finding card before this case can advance." } else { "Address the action listed in the $($top.sop_id) finding card to move the case forward." }
    $line3 = switch ($Disposition.status) {
        "Ineligible"      { "Notify the patient of ineligibility and close the case in EHR." }
        "Deferred"        { "Schedule a 90-day follow-up and provide cessation/support resources." }
        "Hold"            { "Place the case on hold pending requirement completion and set a 30-day check-in." }
        "Action Required" { "Request the outstanding records and re-evaluate when received." }
        "High Complexity" { "Escalate to medical director review before scheduling." }
        "Review"          { "Route to a clinical reviewer for medical risk assessment." }
        "Revision Case"   { "Move the case to the Revision pathway and notify the scheduling team." }
        default           { "Document the call and proceed per the SOP guidance below." }
    }
    return "$line1 $line2 $line3"
}

function Build-LocalNextSteps {
    param($Findings, $Disposition)
    $steps = @()
    $sorted = $Findings | Sort-Object { $STATUS_PRIORITY[$_.status] }
    foreach ($f in $sorted) {
        $steps += "[$($f.sop_id)] $($f.action)"
    }
    switch ($Disposition.status) {
        "Ineligible"       { $steps += "Notify patient of ineligibility and close case in EHR." }
        "Deferred"         { $steps += "Schedule 90-day follow-up and send cessation/support resources." }
        "Hold"             { $steps += "Place case on hold pending requirement completion; set 30-day check-in." }
        "Action Required"  { $steps += "Request outstanding records and re-evaluate when received." }
        "High Complexity"  { $steps += "Escalate case to medical director review." }
        "Review"           { $steps += "Route to clinical reviewer." }
        "Revision Case"    { $steps += "Move case to Revision pathway and notify scheduling team." }
        "Cleared"          { $steps += "Proceed to surgical consultation scheduling." }
    }
    $steps += "Document the call summary and disposition in the patient's EHR record."
    return $steps
}

# --- Claude analysis ------------------------------------------------------------
function Invoke-ClaudeAnalysis {
    param([string]$Transcript, $CrmRecord)
    $sops = (Get-Sops).rules
    $sopBlock = ($sops | ForEach-Object {
        $applies = ($_.applies_to -join ", ")
        "- $($_.id) [$($_.category) / $($_.case_status)] applies_to=[$applies] required_flags=[$($_.required_flags -join ', ')]: finding='$($_.finding)' | trigger_logic='$($_.trigger_logic)' | action='$($_.action)'"
    }) -join "`n"

    # Case type is the ONLY thing we pass from CRM, and only for applies_to gating.
    # Demographic and clinical CRM fields (name, age, sex, BMI, dx, location) are
    # intentionally withheld so the LLM cannot reference them in the output.
    $crmBlock = if ($CrmRecord -and $CrmRecord.case_type) {
        "Case type (use ONLY to gate which SOPs apply via their applies_to lists; do not reference this field in patient_summary or recommendation): $($CrmRecord.case_type)"
    } else { "Case type unknown - apply general SOPs only." }

    $system = @"
You are a clinical data extraction assistant for the Premier Health Care Team.

CRITICAL - NO CRM/EHR GROUNDING: You are given ONLY the patient's case_type plus the call transcript. You do NOT have access to any EHR, CRM, or demographic database. Treat the case_type as a routing tag only - never paraphrase or restate it as patient context. NEVER invent or include the patient's full name, age, sex, location/city/state, BMI, or primary diagnosis in patient_summary or recommendation unless the patient or specialist explicitly stated that fact aloud in the transcript. Phrasing like "per EHR", "per CRM", "according to EHR/CRM", "based on the patient profile", or "presenting with [diagnosis] per EHR" is forbidden. If a fact is not in the transcript text below, do not write it.

CRITICAL - PATIENT CERTAINTY RULE (a finding requires confirmed evidence):
A finding fires ONLY when the patient's response provides direct, confirmed evidence of the triggering fact. Patient hedges signal MISSING DATA, not a triggered rule. Treat the following as non-triggering:
- "maybe", "possibly", "I think", "I'm not sure", "I don't know", "I can't remember", "I don't recall"
- "I did some stuff", "something", "a while back", "a while ago", "at some point"
- Any response where the patient cannot quantify, date, or name the clinical fact being asked about
- The specialist asking the question (the question is not the patient's confirmation)

When the patient is unable to confirm or deny a clinical fact, DO NOT include a finding for that rule. An empty findings array is the CORRECT output for an ambiguous call; you may return zero findings. Producing a finding with hedged evidence ("Maybe?", "It's been a while") is a routing error - the data must be collected via follow-up before a rule fires.

Positive triggers look like clear past-tense affirmation ("I had a sleeve in 2018", "I'm on oxycodone every day"), clear denial ("No, no one has ordered that yet"), or specific numbers ("My A1c was 7.6"). If the evidence is anything weaker than that, omit the finding.

DIRECT DENIAL DOMINATES NEARBY SOFTENING: When a single patient response contains both a direct denial AND softening words about adjacent activities, the direct denial governs. Examples:
- "Honestly no. I tried the gym a couple of times but never did real PT." -> direct denials "Honestly no" and "never did real PT" dominate the softening "tried the gym a couple of times". The patient is confirming attempted_pt == false. JNT-002 fires.
- "No, I haven't seen a dietitian. I looked at some pamphlets once." -> "No, I haven't seen a dietitian" is the direct answer. The pamphlet remark doesn't erase it. has_registered_dietician = false fires BAR-003.
- "I haven't smoked in five years, though I had a cigarette at a wedding last month." -> the recent cigarette is a softening event; the direct denial about being a smoker dominates the active_smoker flag (false), though contradictions warrant a low-confidence note.

This is different from a pure hedge: "Maybe? I think I did something" has NO direct denial and NO direct affirmation - it's all uncertainty, so the rule does not fire. The direct-denial-dominates rule applies only when the response contains an unambiguous yes/no statement about the SOP-relevant fact, with the softening words decorating adjacent details.

Compare the call transcript against the SOPs and return STRICT JSON with this shape:
{
  "patient_summary": "A 3-4 sentence clinical summary GROUNDED ENTIRELY IN THE TRANSCRIPT. Cover the chief concern, key clinical facts the patient or specialist actually said (BMI if stated in the call, prior surgeries mentioned, comorbidities discussed, medications named, lifestyle factors raised), and any red flags raised in conversation. Plain prose, no bullet points. DO NOT reference, paraphrase, or infer from CRM data, demographics, or any patient information not stated in the transcript itself.",
  "recommendation": "A 2-3 sentence narrative recommendation that names the specific SOPs that drove the disposition (cite their IDs like BAR-002) and tells the Specialist what to do next in clinical terms. Reference only what was discussed in the transcript - DO NOT mention EHR/CRM data, demographic context, or facts not present in the call.",
  "findings": [
    { "sop_id": "BAR-002", "title": "...", "category": "...", "finding": "...", "status": "...", "action": "...", "evidence": "short quoted snippet from transcript" }
  ],
  "overall_disposition": { "status": "Ineligible|Deferred|High Complexity|Review|Revision Case|Hold|Action Required|Cleared", "reason": "one-line summary of the most blocking finding" },
  "next_steps": ["short imperative actions specific to THIS patient, derived from patient_summary and recommendation; SOP-tied ones prefixed like [BAR-002]"]
}
Only include findings that are clearly supported by the transcript. Use the exact SOP id, the SOP's case_status as `status`, and copy the SOP's finding text into `title`. Each SOP has an `applies_to` list - only fire SOPs whose applies_to includes the patient's case_type (case-insensitive).

Disposition priority (lower number = more blocking, MUST be applied strictly):
1. Ineligible
2. Deferred
3. High Complexity
4. Review
5. Revision Case
6. Hold
7. Action Required
8. Cleared (only when no SOPs are triggered)

To set overall_disposition.status: take the status field of EVERY finding, look up its priority number above, pick the finding with the LOWEST number, and copy its status verbatim. Do not aggregate, average, or substitute. If a Revision Case finding (priority 5) coexists with a Hold finding (priority 6), the disposition is Revision Case.

CONSISTENCY RULE - the findings array is the source of truth:
Write 'findings' FIRST, then derive 'recommendation', 'patient_summary', and 'next_steps' from it. Every SOP ID you cite in 'recommendation' or 'patient_summary' MUST appear as an entry in the 'findings' array - and vice versa, every SOP ID in 'findings' must be referenced by the 'recommendation' it drove. Never mention a SOP id in prose that isn't in the structured findings list. If you decided the Patient Certainty Rule prevents JNT-002 from firing (so JNT-002 is NOT in findings), then JNT-002 must NOT appear in the recommendation either - drop it from the prose. This consistency check prevents the case where the prose says "two SOPs fire" but the structured output only lists one.

The 'overall_disposition.status' field also follows from findings alone: compute it from the case_status values of the items actually in findings (using the strict priority rule above), never from rules you only described in prose.

How to build next_steps (do this LAST, after writing patient_summary, recommendation, findings, and overall_disposition):
1. Re-read the patient_summary and recommendation you just wrote. Every step must be traceable to something stated there.
2. Produce 3-7 short, imperative steps in execution order (most blocking first, mirroring the disposition priority).
3. For EVERY entry in findings, produce one step prefixed with its SOP id in brackets, e.g. "[BAR-002] Order pre-op EGD and place case on hold until results are reviewed." This is mandatory: a finding without a corresponding [SOP-ID] step is a routing error. If two findings fired, you produce two SOP-prefixed steps - one each - even when one finding drives the overall disposition. The disposition tail step and documentation step come AFTER all SOP-prefixed steps.
4. After the SOP-tied steps, add a disposition-specific tail step (e.g. "Notify patient of ineligibility and close case in EHR" for Ineligible; "Schedule 90-day follow-up with cessation resources" for Deferred).
5. End with one documentation step: "Document the call summary, disposition, and next-step assignments in the patient's EHR record."
6. Steps must be patient-specific (use names, dosages, timeframes pulled from the transcript when present). Do NOT emit generic placeholders like "follow up with patient."
"@

    $user = @"
SOPs:
$sopBlock

$crmBlock

Transcript:
$Transcript
"@

    $bodyObj = @{
        model = $AnthropicModel
        max_tokens = 1500
        system = $system
        messages = @(@{ role = "user"; content = $user })
    }
    $bodyJson = $bodyObj | ConvertTo-Json -Depth 10
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

    $headers = @{
        "x-api-key"         = $AnthropicKey
        "anthropic-version" = "2023-06-01"
        "content-type"      = "application/json"
    }

    try {
        $rawResp = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "https://api.anthropic.com/v1/messages" -Headers $headers -Body $bodyBytes -ContentType "application/json"
        $respText = [System.Text.Encoding]::UTF8.GetString($rawResp.RawContentStream.ToArray())
        $respObj  = $respText | ConvertFrom-Json
        $text = $respObj.content[0].text
        # Extract the JSON object even if Claude wraps it in prose or fences.
        $first = $text.IndexOf("{")
        $last  = $text.LastIndexOf("}")
        if ($first -ge 0 -and $last -gt $first) {
            $text = $text.Substring($first, $last - $first + 1)
        }
        $parsed = $text.Trim() | ConvertFrom-Json
        return [pscustomobject]@{
            engine              = "claude"
            model               = $AnthropicModel
            patient_summary     = $parsed.patient_summary
            recommendation      = $parsed.recommendation
            findings            = $parsed.findings
            overall_disposition = $parsed.overall_disposition
            next_steps          = $parsed.next_steps
        }
    } catch {
        $errBody = ""
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                $errBody = $reader.ReadToEnd()
            } catch {}
        }
        throw "Claude API error: $($_.Exception.Message). Body: $errBody"
    }
}

# --- Gemini evaluation ----------------------------------------------------------
function Invoke-GeminiEvaluation {
    param(
        [string]$Transcript,
        [string]$PatientSummary,
        [string]$Recommendation,
        $NextSteps,
        $Findings,
        $OverallDisposition
    )
    if (-not $GeminiKey) { throw "Gemini API key not configured" }

    $stepsText = if ($NextSteps) { ($NextSteps | ForEach-Object { "- $_" }) -join "`n" } else { "(none)" }
    $findingsText = if ($Findings) {
        ($Findings | ForEach-Object { "- $($_.sop_id) [$($_.status)]: $($_.finding)" }) -join "`n"
    } else { "(none)" }
    $dispText = if ($OverallDisposition) { "$($OverallDisposition.status) - $($OverallDisposition.reason)" } else { "(unknown)" }

    $systemInstruction = @"
You are a clinical QA evaluator scoring how well a Care Specialist's analysis matches the call transcript and SOP findings. Return STRICT JSON only, no prose, no code fences. Shape:
{
  "recommendation": { "score": 0-100, "rationale": "one sentence" },
  "next_steps":     { "score": 0-100, "rationale": "one sentence" }
}
Scoring guide:
- 76-100 = strongly grounded in transcript, cites correct SOPs, actionable, complete.
- 51-75  = mostly correct but with a noticeable gap, generic phrasing, or one minor mismatch.
- 0-50   = unsupported by transcript, contradicts findings, or missing critical actions.
Be calibrated: a perfect output is rare; do not score above 90 unless the output explicitly cites SOP IDs and quotes patient evidence.
"@

    $user = @"
TRANSCRIPT:
$Transcript

OVERALL DISPOSITION: $dispText

FINDINGS:
$findingsText

RECOMMENDATION TO EVALUATE:
$Recommendation

NEXT STEPS TO EVALUATE:
$stepsText
"@

    $bodyObj = @{
        system_instruction = @{ parts = @(@{ text = $systemInstruction }) }
        contents = @(@{ role = "user"; parts = @(@{ text = $user }) })
        generationConfig = @{ responseMimeType = "application/json"; temperature = 0.2 }
    }
    $bodyJson = $bodyObj | ConvertTo-Json -Depth 10
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

    $uri = "https://generativelanguage.googleapis.com/v1beta/models/$($GeminiModel):generateContent?key=$GeminiKey"

    try {
        $rawResp = Invoke-WebRequest -UseBasicParsing -Method POST -Uri $uri -Body $bodyBytes -ContentType "application/json"
        $respText = [System.Text.Encoding]::UTF8.GetString($rawResp.RawContentStream.ToArray())
        $respObj  = $respText | ConvertFrom-Json
        $text = $respObj.candidates[0].content.parts[0].text
        $first = $text.IndexOf("{")
        $last  = $text.LastIndexOf("}")
        if ($first -ge 0 -and $last -gt $first) { $text = $text.Substring($first, $last - $first + 1) }
        $parsed = $text.Trim() | ConvertFrom-Json
        return [pscustomobject]@{
            recommendation = $parsed.recommendation
            next_steps     = $parsed.next_steps
            model          = $GeminiModel
        }
    } catch {
        $errBody = ""
        if ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                $errBody = $reader.ReadToEnd()
            } catch {}
        }
        throw "Gemini API error: $($_.Exception.Message). Body: $errBody"
    }
}

# --- request router -------------------------------------------------------------
function Handle-Request {
    param($Context)
    $req  = $Context.Request
    $resp = $Context.Response
    $resp.Headers["Access-Control-Allow-Origin"] = "*"
    $resp.Headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
    $resp.Headers["Access-Control-Allow-Headers"] = "Content-Type"

    if ($req.HttpMethod -eq "OPTIONS") { $resp.StatusCode = 204; $resp.OutputStream.Close(); return }

    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod

    try {
        # --- API ------------------------------------------------------------
        if ($path -eq "/api/health") {
            Write-Json $resp @{
                ok = $true
                engine = if ($AnthropicKey) { "claude" } else { "local" }
                model = $AnthropicModel
                evaluator = if ($GeminiKey) { "gemini" } else { $null }
                evaluator_model = if ($GeminiKey) { $GeminiModel } else { $null }
            }
            return
        }

        if ($path -eq "/api/evaluate" -and $method -eq "POST") {
            if (-not $GeminiKey) { Write-Json $resp @{ ok = $false; error = "Gemini key not configured" } 503; return }
            $body = Read-RequestBody $req | ConvertFrom-Json
            try {
                $eval = Invoke-GeminiEvaluation `
                    -Transcript $body.transcript `
                    -PatientSummary $body.patient_summary `
                    -Recommendation $body.recommendation `
                    -NextSteps $body.next_steps `
                    -Findings $body.findings `
                    -OverallDisposition $body.overall_disposition
                Write-Json $resp @{ ok = $true; evaluator = "gemini"; model = $eval.model; recommendation = $eval.recommendation; next_steps = $eval.next_steps }
            } catch {
                Write-Json $resp @{ ok = $false; error = $_.Exception.Message } 500
            }
            return
        }

        if ($path -eq "/api/sops" -and $method -eq "GET") {
            Write-Json $resp (Get-Sops); return
        }
        if ($path -eq "/api/sops" -and $method -eq "POST") {
            $body = Read-RequestBody $req | ConvertFrom-Json
            $doc = Get-Sops
            if (-not $body.id) { Write-Json $resp @{ ok = $false; error = "id required" } 400; return }
            if ($doc.rules | Where-Object { $_.id -eq $body.id }) {
                Write-Json $resp @{ ok = $false; error = "id already exists" } 409; return
            }
            $doc.rules = @($doc.rules) + $body
            Save-Sops $doc
            Write-Json $resp @{ ok = $true; sop = $body }
            return
        }
        if ($path -match "^/api/sops/([A-Za-z0-9_\-]+)$") {
            $id = $matches[1]
            $doc = Get-Sops
            $existing = $doc.rules | Where-Object { $_.id -eq $id }
            if ($method -eq "PUT") {
                if (-not $existing) { Write-Json $resp @{ ok = $false; error = "not found" } 404; return }
                $body = Read-RequestBody $req | ConvertFrom-Json
                $doc.rules = @($doc.rules | ForEach-Object { if ($_.id -eq $id) { $body } else { $_ } })
                Save-Sops $doc
                Write-Json $resp @{ ok = $true; sop = $body }
                return
            }
            if ($method -eq "DELETE") {
                if (-not $existing) { Write-Json $resp @{ ok = $false; error = "not found" } 404; return }
                $doc.rules = @($doc.rules | Where-Object { $_.id -ne $id })
                Save-Sops $doc
                Write-Json $resp @{ ok = $true; deleted = $id }
                return
            }
        }

        if ($path -eq "/api/sso/signin" -and $method -eq "POST") {
            # Mock SSO. In real use this would be Okta/Azure AD via OAuth.
            Start-Sleep -Milliseconds 600
            $user = @{
                id = "u-7421"
                name = "Jordan G"
                email = "jordan.g@premierhealth.example"
                role = "Care Specialist"
                team = "Bariatric & Joint Pod 2"
                avatar_initials = "JG"
                provider = "Premier SSO (Okta)"
                signed_in_at = (Get-Date).ToString("o")
            }
            Write-Json $resp @{ ok = $true; user = $user }
            return
        }

        if ($path -eq "/api/crm/lookup" -and $method -eq "POST") {
            $body = Read-RequestBody $req | ConvertFrom-Json
            $rec = Get-CrmByQuery -Name $body.name -PatientId $body.patient_id
            if ($rec) { Write-Json $resp @{ ok = $true; crm_record = $rec } }
            else      { Write-Json $resp @{ ok = $true; crm_record = $null; note = "No record found in mock EHR. Demo only includes 3 sample patients." } }
            return
        }

        if ($path -eq "/api/integrations/import" -and $method -eq "POST") {
            $body = Read-RequestBody $req | ConvertFrom-Json
            $source = $body.source
            Start-Sleep -Milliseconds 500
            # Mock: pretend we pulled a transcript from the named system.
            $sample = $null
            switch ($source) {
                "googleworkspace" {
                    $sample = "Specialist: Hi Sarah, thanks for hopping on. I want to walk through your bariatric case today.`nPatient: Sure. So you know I had a sleeve back in 2018 and I'm here because I'm thinking about a revision.`nSpecialist: Got it. Have you had an EGD recently?`nPatient: No, no one has ordered that yet.`nSpecialist: And nutrition - have you been seeing a registered dietitian?`nPatient: I saw a nutritionist once a few months ago.`n"
                }
                "five9" {
                    $sample = "Specialist: Hi Bob, thanks for the time. We're talking through your right knee replacement.`nPatient: Yeah, the knee is killing me.`nSpecialist: Have you done a course of supervised physical therapy?`nPatient: Honestly no. I tried the gym a couple of times but never did real PT.`nSpecialist: And pain management - what are you taking?`nPatient: I've been on oxycodone every day for about eight months. My doctor has me on it.`nSpecialist: Got it.`n"
                }
                default {
                    $sample = "Specialist: Hi Maria, how are you today?`nPatient: I am doing alright. I still smoke about half a pack a day - I tried to quit last year but it did not stick. My last A1c was 7.6.`nSpecialist: Thanks for sharing.`n"
                }
            }
            Write-Json $resp @{ ok = $true; source = $source; transcript = $sample; imported_at = (Get-Date).ToString("o") }
            return
        }

        if ($path -eq "/api/integrations/export" -and $method -eq "POST") {
            $body = Read-RequestBody $req | ConvertFrom-Json
            $target = $body.target
            $payloadKind = $body.kind
            Start-Sleep -Milliseconds 700
            $ref = "EXP-" + (Get-Random -Minimum 100000 -Maximum 999999)
            Write-Json $resp @{ ok = $true; target = $target; kind = $payloadKind; reference = $ref; exported_at = (Get-Date).ToString("o") }
            return
        }

        if ($path -eq "/api/analyze" -and $method -eq "POST") {
            $started = Get-Date
            $body = Read-RequestBody $req | ConvertFrom-Json
            $transcript = $body.transcript
            if (-not $transcript) { Write-Json $resp @{ ok = $false; error = "transcript required" } 400; return }

            $crm = Get-CrmByQuery -Name $body.patient_name -PatientId $body.patient_id
            if (-not $crm) { $crm = Get-CrmFromTranscript -Transcript $transcript }

            $result = if ($AnthropicKey) {
                try { Invoke-ClaudeAnalysis -Transcript $transcript -CrmRecord $crm }
                catch {
                    # Fall back to local if Claude fails, but surface the error.
                    $local = Invoke-LocalAnalysis -Transcript $transcript -CrmRecord $crm
                    $local | Add-Member -NotePropertyName claude_error -NotePropertyValue $_.Exception.Message -Force
                    $local
                }
            } else {
                Invoke-LocalAnalysis -Transcript $transcript -CrmRecord $crm
            }

            $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
            $out = @{
                ok                  = $true
                engine              = $result.engine
                model               = $result.model
                crm_record          = $crm
                patient_summary     = $result.patient_summary
                recommendation      = $result.recommendation
                findings            = $result.findings
                overall_disposition = $result.overall_disposition
                next_steps          = $result.next_steps
                elapsed_ms          = $elapsed
            }
            if ($result.PSObject.Properties["claude_error"]) { $out.claude_error = $result.claude_error }
            Write-Json $resp $out
            return
        }

        # --- static (served from /public, mirrors Next.js conventions) -----
        if ($method -eq "GET") {
            $rel = if ($path -eq "/" -or $path -eq "") { "/app.html" } else { $path }
            $file = Join-Path (Join-Path $ScriptDir "public") ($rel.TrimStart("/"))
            if ((Test-Path $file) -and (Get-Item $file).PSIsContainer -eq $false) {
                Write-Static $resp $file; return
            }
        }

        Write-Text $resp "Not Found" "text/plain; charset=utf-8" 404
    } catch {
        try { Write-Json $resp @{ ok = $false; error = $_.Exception.Message } 500 } catch {}
    }
}

# --- main loop ------------------------------------------------------------------
$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Host "Failed to start listener on $prefix : $($_.Exception.Message)"
    Write-Host "If this is an access-denied error, try a different port or run: netsh http add urlacl url=$prefix user=$env:USERNAME"
    exit 1
}

$engineBanner = if ($AnthropicKey) { "Claude ($AnthropicModel)" } else { "local heuristic" }
Write-Host "Premier Call Transcript Analyzer listening on $prefix"
Write-Host "Engine: $engineBanner"
Write-Host "Open http://localhost:$Port/app.html in your browser. Ctrl+C to stop."

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        Handle-Request -Context $ctx
    } catch {
        Write-Host "Request error: $($_.Exception.Message)"
    }
}
