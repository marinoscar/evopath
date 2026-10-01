package com.enterpriseapp.android.util

import com.enterpriseapp.android.BuildConfig

/**
 * The product identity, as generated into [BuildConfig] from `packages/shared/identity.json`
 * (see app/build.gradle.kts). User-facing text names the product through this object, never
 * through a literal, so a fork renamed with `scripts/rename.mjs` needs no code change here.
 */
object Brand {
    /** Display name, e.g. in "Pair with <name>". */
    val name: String = BuildConfig.PRODUCT_NAME

    /** [name] without spaces or punctuation (user agent, log tags), e.g. `Some Name` → `SomeName`. */
    val compactName: String = compact(BuildConfig.PRODUCT_NAME)

    /** Custom scheme of the app's deep links (`<scheme>://health-sync`). */
    val deepLinkScheme: String = BuildConfig.DEEP_LINK_SCHEME

    /** The Health sync deep link the web app's "Open Health sync" button uses. */
    val healthSyncUri: String = "$deepLinkScheme://health-sync"

    fun compact(productName: String): String = productName.filter { it.isLetterOrDigit() && it.code < 128 }.ifEmpty { "App" }
}
