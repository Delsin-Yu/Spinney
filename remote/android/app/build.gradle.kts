import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // Kotlin 2.0+: the Compose compiler ships as its own Gradle plugin.
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.spinney.remote.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.spinney.remote.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core"))

    // Compose (versions from the BOM; every module the UI uses is declared, none is implied).
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")

    // The phone's own HTTP stack used to live here; the room transport moved into `:core`
    // (`RemoteClient.kt`) so a plain JVM can drive it (`tools/remote-interop.mjs`). OkHttp now
    // arrives transitively with `:core`, which is where it belongs.

    // CameraX: the live "point the phone at the desktop's code" gesture (`CameraScanScreen.kt`).
    // `camera-view` brings `PreviewView`; `camera-camera2` is the backend, the only one that exists
    // on the API 26+ devices this app targets and the one that needs no Google Play Services — the
    // test phone is a Huawei device without them, which is why CameraX and not ML Kit or GMS's
    // barcode scanner. Every module the screen uses is declared here, none is implied.
    val camerax = "1.4.1"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-view:$camerax")

    // WebViewCompat.addWebMessageListener: the origin-checked, big-payload bridge to the page.
    implementation("androidx.webkit:webkit:1.12.1")

    // EncryptedSharedPreferences: the token's only home on the phone.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    implementation("androidx.core:core-ktx:1.13.1")
    // StateFlow/SharedFlow are what carry the connection state and the mirrored messages.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
