# EvoPath Android release (R8) rules.

# --- kotlinx.serialization ---------------------------------------------------
# The library ships consumer rules for the runtime; keep generated serializers of
# our own @Serializable classes (named companions / $serializer) explicitly.
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class com.evopath.android.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class com.evopath.android.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.evopath.android.**$$serializer { *; }

# --- OkHttp ------------------------------------------------------------------
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- androidbrowserhelper ----------------------------------------------------
# Activities/services are referenced from the manifest (kept by AAPT); the
# library uses no reflection beyond that.
-dontwarn com.google.androidbrowserhelper.**

# --- security-crypto (Tink) --------------------------------------------------
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# --- WorkManager -------------------------------------------------------------
# WorkManager stores the worker's class name in its database and instantiates it by
# reflection; the library's consumer rules keep names/constructors of reachable workers.
# Pin ours explicitly so a rename by R8 can never orphan scheduled work across updates.
-keep class com.evopath.android.sync.HealthSyncWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# --- Health Connect ----------------------------------------------------------
# connect-client ships consumer rules for its protobuf messages and parcelables.
# Record classes are referenced as Kotlin class literals (ReadRecordsRequest(recordType = …)),
# which R8 keeps; nothing is looked up by name.
