import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun releaseSecret(name: String): String? =
    providers.environmentVariable(name).orNull
        ?: providers.gradleProperty(name).orNull

val releaseStorePath = releaseSecret("ORCA_ANDROID_KEYSTORE_PATH")
val releaseStorePassword = releaseSecret("ORCA_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = releaseSecret("ORCA_ANDROID_KEY_ALIAS")
val releaseKeyPassword = releaseSecret("ORCA_ANDROID_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseStorePath,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    compileSdk = 36
    namespace = "com.meeks233.orca"
    defaultConfig {
        // Allow http:// so the app can reach a self-hosted Orca server on a LAN.
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "com.meeks233.orca"
        // Raised from 24 → 28: the share-target plugin requires Android 9+.
        minSdk = 28
        // Google Play requires API 36 for new apps and updates from 2026-08-31.
        // ShareActivity remains opaque and uses explicit SEND/VIEW filters so it
        // complies with Android 16's safer-intent handling.
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            // NOTE: the Tauri template keeps native debug symbols here
            // (jniLibs.keepDebugSymbols) which bloats the debug APK to ~550MB.
            // We drop it so AGP strips the Rust .so files — the debug APK is a
            // functional test build, not a native-debugging build. Cuts the
            // APK to tens of MB.
        }
        getByName("release") {
            isMinifyEnabled = true
            signingConfigs.findByName("release")?.let { signingConfig = it }
            proguardFiles(
                *fileTree(".") {
                    include("**/*.pro")
                    // fileTree(".") also walks build/, where AGP unpacks each
                    // dependency's consumer ProGuard rules — so a warm build saw
                    // .pro files a clean build never does, making the output
                    // depend on whether build/ happened to be populated. F-Droid
                    // verifies our APK by rebuilding it, so that has to be
                    // deterministic.
                    exclude("build/**")
                }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    // JDK 21 (this machine's build JDK) has *deprecated* compiling to Java 8
    // bytecode and prints an obsolete-source/target warning on every build.
    // compileSdk 36 / minSdk 28 fully support Java 17 language + bytecode
    // levels, so target 17 to silence the noise at its root rather than
    // suppressing the message.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
