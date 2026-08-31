func RunCoachDemo(app interface{}, sessionID string, personaConfig models.PersonaConfig, state models.SessionState, userLastMessage string, history []ChatMessage) (*CoachDemoResult, error) {
    shared := pf.Shared{
        "app":            app,
        "sessionID":      sessionID,
        "userContent":    userLastMessage,
        "personaConfig":  personaConfig,
        "state":          state,
    }
    
    coachNode := pf.NewFuncNodeFull(
        func(s pf.Shared) (any, error) { return s, nil },
        func(p any) (any, error) {
            s := p.(pf.Shared)
            st := s["state"].(models.SessionState)
            cfg := s["personaConfig"].(models.PersonaConfig)
            msg := s["userContent"].(string)
            
            systemPrompt := CompileCoachDemoPrompt(cfg, st, msg)
            messages := make([]ChatMessage, len(history))
            copy(messages, history)
            
            resp, err := CallLLM(context.Background(), systemPrompt, messages, 1000)
            if err != nil { return nil, err }
            return resp, nil
        },
        func(s pf.Shared, _, execRes any) (string, error) {
            resp := execRes.(string)
            var result CoachDemoResult
            if err := json.Unmarshal([]byte(resp), &result); err != nil {
                result = CoachDemoResult{RewrittenMessage: resp, Critique: "Failed to parse JSON.", Explanation: ""}
            }
            s["coachDemoResult"] = &result
            return "default", nil
        },
    )
    
    flow := pf.NewFlow(coachNode)
    _, err := flow.Run(shared)
    if err != nil { return nil, err }
    return shared["coachDemoResult"].(*CoachDemoResult), nil
}

type CoachDemoResult struct {
    Critique         string `json:"critique"`
    RewrittenMessage string `json:"rewritten_message"`
    Explanation      string `json:"explanation"`
}