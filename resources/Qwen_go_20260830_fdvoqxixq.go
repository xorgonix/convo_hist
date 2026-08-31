func HandleHoldMyBeer(e *core.RequestEvent) error {
    // ... (standard session/persona fetching logic) ...
    result, err := engine.RunCoachDemo(e.App, sessionID, personaConfig, state, userLastMessage, history)
    if err != nil {
        return e.InternalServerError("Coach demo failed", err)
    }
    return renderPartial(e, "templates/partials/coach_demo.tmpl", map[string]any{
        "Result": result,
    })
}