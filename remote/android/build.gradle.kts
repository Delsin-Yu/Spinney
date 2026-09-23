// Root build file: only declares the plugin versions, nothing is applied here.
// Versions were chosen because they resolve against the warm ~/.gradle/caches on
// this machine (Gradle 8.11.1 / JDK 17 / compileSdk 35):
//   AGP 8.7.3        needs Gradle >= 8.9  -> OK with 8.11.1, supports compileSdk 35
//   Kotlin 2.0.21    kotlin-gradle-plugin + compose compiler plugin both cached
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.jvm") version "2.0.21" apply false
}
