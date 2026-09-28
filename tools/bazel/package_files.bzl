"""Package-local source visibility helpers for generated BUILD files."""

def export_package_files(include):
    """Exports files matched inside one Bazel package without making them target inputs."""
    native.exports_files(
        native.glob(
            include,
            exclude = ["BUILD", "BUILD.bazel"],
            allow_empty = True,
        ),
        visibility = ["//:__subpackages__"],
    )
