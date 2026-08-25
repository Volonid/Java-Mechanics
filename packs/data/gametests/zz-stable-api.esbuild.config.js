module.exports = {
    config: (settings) => {
        if (!Array.isArray(settings.modules)) return;

        settings.modules = settings.modules.map((module) =>
            module.startsWith('@minecraft/server@')
                ? '@minecraft/server@2.9.0'
                : module,
        );
    },
};
