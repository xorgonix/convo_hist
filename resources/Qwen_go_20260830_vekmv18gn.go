func CompileCoachDemoPrompt(p models.PersonaConfig, s models.SessionState, userLastMessage string) string {
    var sb strings.Builder
    
    fmt.Fprintf(&sb, "You are an elite dating and communication coach. The user is practicing texting with %s. \n", p.Name)
    fmt.Fprintf(&sb, "The user just sent (or is about to send): \"%s\"\n\n", userLastMessage)
    
    sb.WriteString("CURRENT CHEMISTRY STATE:\n")
    fmt.Fprintf(&sb, "- Warmth: %d/10\n", s.Warmth)
    fmt.Fprintf(&sb, "- Trust: %d/10\n", s.Trust)
    fmt.Fprintf(&sb, "- Flirtation: %d/10\n", s.Flirtation)
    fmt.Fprintf(&sb, "- Irritation: %d/10\n\n", s.Irritation)
    
    sb.WriteString("YOUR TASK:\n")
    sb.WriteString("1. CRITIQUE: Briefly explain (1-2 sentences) why the user's message is suboptimal given the current chemistry state.\n")
    sb.WriteString("2. REWRITE: Provide the exact text you would send instead to maximize engagement, warmth, or flirtation without being creepy.\n")
    sb.WriteString("3. EXPLAIN: Briefly explain (1-2 sentences) why your rewrite works better psychologically.\n\n")
    sb.WriteString("OUTPUT FORMAT: Return STRICT JSON only. No markdown, no conversational filler.\n")
    sb.WriteString(`{
  "critique": "Your message is too needy given her current irritation level...",
  "rewritten_message": "Actually, I'm busy tonight, but let's grab coffee Thursday.",
  "explanation": "This re-establishes your frame, shows you have a life, and offers a specific alternative without pressure."
}`)
    
    return sb.String()
}