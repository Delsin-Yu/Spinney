// Minimal Android + pure-Kotlin/JVM skeleton for the Spinney remote client.
// Pinned toolchain (proven on this machine, see README.md):
//   Gradle 8.11.1, JDK 17, AGP 8.7.3, Kotlin 2.0.21, compileSdk 35.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "spinney-remote-android"

include(":app")
include(":core")
