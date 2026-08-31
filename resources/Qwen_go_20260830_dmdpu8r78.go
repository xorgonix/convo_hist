type KnowledgeExporter interface {
    Export(data ProcessedChatData) error
}