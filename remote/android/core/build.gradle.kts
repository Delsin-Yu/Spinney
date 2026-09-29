import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    // Pure Kotlin/JVM: NO Android plugin, so tests run on the local JDK with plain JUnit 5.
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // The room transport (`RemoteClient`) lives here, in pure JVM Kotlin: OkHttp is a JVM
    // library, and `kotlinx-coroutines-core` is what carries the connection state and the
    // mirrored frames to whoever is rendering them. Neither is an Android dependency, which is
    // the point — see the header of `RemoteClient.kt`.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")

    // The QR *decoder* the phone reads a pairing code with (`QrScan.kt`). zxing-core is pure Java
    // with no Play Services, no AAR and no native code, so it is legal in a plain JVM module on
    // Android as well as on the desktop JVM the tests run on — which is what lets the same
    // `QrScan.decode` read the committed fixture in `src/test/resources/pairing-fixture.png`.
    // See `QrScan.kt`'s header for why a hand-rolled decoder was not an option.
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

/**
 * The interop harness's entry point, as ONE runnable jar.
 *
 * `tools/remote-interop.mjs` has to start a Kotlin peer with a single command on a machine whose
 * only Kotlin toolchain is this Gradle build, so this task shades the runtime classpath
 * (kotlin-stdlib, OkHttp, Okio, coroutines) into `build/libs/spinney-interop.jar` and the script
 * then runs a plain `java -cp <jar> dev.spinney.remote.core.InteropMain …`. `--no-daemon` on that
 * one build is what the script uses, so no Gradle daemon is left behind by a test run.
 *
 * This is a dev-only artifact: it is never shipped, and the whole of `remote/` is outside the `.vsix`.
 */
tasks.register<Jar>("interopJar") {
    group = "verification"
    description = "Fat jar with the interop entry point, for tools/remote-interop.mjs"
    archiveFileName.set("spinney-interop.jar")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    manifest {
        attributes("Main-Class" to "dev.spinney.remote.core.InteropMain")
    }
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
        configurations.runtimeClasspath.get()
            .filter { it.name.endsWith(".jar") }
            .map { zipTree(it) }
    }) {
        // Signature files from a shaded dependency make the jar unloadable; module descriptors
        // of the individual jars are meaningless once merged.
        exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/MANIFEST.MF")
        exclude("module-info.class", "META-INF/versions/*/module-info.class")
    }
}

tasks.test {
    useJUnitPlatform()

    // ---------------------------------------------------------------------------
    // Reading a file that lives OUTSIDE this module (remote/vectors/vectors.json).
    //
    // Mechanism proven to work: a Gradle `systemProperty` carrying an ABSOLUTE,
    // canonicalized path. The test reads System.getProperty("spinney.vectors");
    // it never depends on the JVM's working directory (Gradle runs the test JVM
    // with a working dir of the *module* directory, not the root project), and it
    // never depends on the file being copied. `rootProject.file(...)` resolves
    // against remote/android/, so "../vectors/vectors.json" is remote/vectors/.
    //
    // The alternative (a Copy task into build/resources/test, read via
    // getResourceAsStream) also works but duplicates a 900 KB file on every run --
    // use systemProperty unless the test must be hermetic.
    // ---------------------------------------------------------------------------
    val vectorsJson = rootProject.file("../vectors/vectors.json")
    systemProperty("spinney.vectors", vectorsJson.canonicalFile.absolutePath)

    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
