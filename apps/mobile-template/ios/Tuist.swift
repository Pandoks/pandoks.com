import ProjectDescription

let tuist = Tuist(
    project: .tuist(
        compatibleXcodeVersions: .all,
        generationOptions: .options(
            enforceExplicitDependencies: true
        )
    )
)
