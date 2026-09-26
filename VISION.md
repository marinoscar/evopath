# EvoPath — VISION.md

## Document Purpose

This document defines the product vision for **EvoPath**, a personal health improvement application designed to help people understand their health, organize their health information, turn that information into practical plans, and continuously measure whether those plans are working.

This is intentionally **not** a technical architecture document, repository guide, implementation specification, or technology-selection document. It focuses on the desired product experience, user outcomes, feature behavior, design principles, major capabilities, and the relationship between those capabilities.

The purpose of this document is to provide enough detail that future product requirements, user stories, workflows, data models, interface designs, and implementation plans can be derived from it without losing the original intent of the product.

---

# 1. Product Vision

## 1.1 The Problem

Most people have health information spread across many disconnected places:

- Lab PDFs from different providers
- DEXA or body-composition reports
- Smart scales
- Blood-pressure cuffs
- Fitness apps
- Workout notes
- Photos of gym equipment
- Food-tracking apps
- Meal photos
- Medication lists
- Notes from doctors
- Personal goals
- Weight history
- Heart-rate data
- Subjective feelings such as stress, energy, soreness, motivation, and sleep quality

The information exists, but it is fragmented.

Even when a person has access to the data, it is difficult to answer simple questions such as:

- Am I becoming healthier?
- Which biomarkers are improving or getting worse?
- Did I lose fat, muscle, or both?
- What changed since my last blood test?
- What should I focus on now?
- What should I do at the gym today?
- What can I do with the equipment available here?
- What should I eat this week?
- Am I getting closer to my goals?
- Is the plan actually working?
- What did this number come from?
- Can I trust what the AI extracted from my report?
- How does my current health compare with my own historical baseline?
- What should I discuss with my doctor?

Traditional health apps typically solve only one piece of this problem.

Fitness apps track workouts.

Food apps track calories.

Lab platforms display biomarkers.

Wearables track activity and recovery.

Medical portals store medical records.

General-purpose AI assistants can explain information, but usually do not have a durable, structured, source-linked longitudinal health record for the user.

**EvoPath exists to connect these pieces into one personal health improvement system.**

---

# 2. Core Product Promise

EvoPath should help a user:

1. **Collect** health information.
2. **Organize** it into a structured personal health history.
3. **Verify** where every important value came from.
4. **Understand** what the information means.
5. **Define** meaningful health and fitness goals.
6. **Create** practical plans for improvement.
7. **Execute** those plans through workouts and nutrition.
8. **Track** adherence and progress.
9. **Adapt** plans as the user changes.
10. **Measure again** and determine whether the plan is working.

The core loop is:

> **Measure → Understand → Plan → Act → Track → Reassess → Improve**

EvoPath should not be merely a place where health information is stored.

It should be a system that helps a person **turn health information into better decisions and sustained behavior**.

---

# 3. Product Positioning

EvoPath should be thought of as a:

> **Personal Health Operating System**

It should unify:

- Personal health profile
- Medical and wellness measurements
- Blood work
- Body composition
- DEXA scans
- Vital signs
- Medications
- Goals
- Workouts
- Training programs
- Gym and equipment profiles
- Nutrition
- Meal planning
- Food logging
- Subjective wellness
- AI coaching
- Progress tracking
- Gamification
- Source documents and images

The value of EvoPath is not any one of these features by itself.

The value is that the features **share context**.

The workout coach should understand the user's goals and training history.

The nutrition coach should understand the user's body-composition goals and meal history.

The AI health assistant should understand the user's health measurements, medications, preferences, goals, and lifestyle.

The user should not have to repeatedly explain who they are.

---

# 4. Product Philosophy

## 4.1 One Person, One Longitudinal Health Record

EvoPath should maintain a continuously growing history of the user's health.

Every measurement should exist in time.

Examples:

- Weight on a specific date
- LDL on a specific date
- Blood pressure at a specific time
- DEXA body-fat percentage from a specific scan
- Medication start date
- Workout on a specific day
- Meal eaten at a specific time
- Stress score on a specific evening
- Goal created at a specific point in time

The application should make it easy to see:

- where the user started,
- where the user is today,
- what changed,
- what actions happened between measurements,
- and what the user is trying to accomplish next.

---

## 4.2 Simple When the User Wants Simple, Advanced When the Data Supports It

EvoPath must support very different levels of detail.

A user may want to enter only:

- Weight: 210 lb

Another user may enter:

- Weight
- Body-fat percentage
- Waist circumference

Another may upload a detailed DEXA report containing dozens of measurements.

All three experiences are valid.

The application should never require advanced data in order to provide a useful experience.

The user should be able to begin with the smallest useful amount of information and gradually build a richer health profile over time.

---

## 4.3 AI Proposes; the User Remains in Control

Any information created or interpreted by AI should be reviewable.

Any AI-extracted value should be editable.

Any AI-generated plan should be editable.

Any AI-recognized food should be editable.

Any AI-recognized gym equipment should be editable.

The application must never treat an AI guess as unquestionable truth.

The user should always be able to:

- confirm,
- correct,
- override,
- delete,
- or manually enter information.

---

## 4.4 Provenance Is a First-Class Product Concept

For important health data, EvoPath should know where the information came from.

For example:

> LDL: 98 mg/dL  
> Source: Quest Diagnostics blood work  
> Date: September 15  
> Page: 2  
> Extracted by AI  
> Confirmed by user

The user should be able to navigate from the structured value back to the original source.

If a user changes an extracted value, EvoPath should preserve the fact that:

- the original document contained one value,
- the AI extracted a particular value,
- the user corrected it,
- and the corrected value is now the active value.

The application should preserve trust by making health information traceable.

---

## 4.5 Health Truth and AI Personality Are Separate

EvoPath may allow the AI to communicate differently based on user preference.

For example:

- Direct
- Encouraging
- Analytical
- Calm
- Highly structured
- Concise
- Detailed
- Motivational

However, AI personality must not alter health facts or safety.

A direct coach and a gentle coach should use different wording, but they should not provide contradictory health guidance because of personality settings.

---

# 5. Target User

EvoPath is intended for people who want greater control and visibility over their health.

Potential users include people who:

- regularly get blood work,
- are losing weight,
- want to gain muscle,
- care about body composition,
- train in gyms,
- travel frequently,
- use home gyms,
- want to improve cardiovascular health,
- track blood pressure,
- want to understand trends in health metrics,
- use medications,
- want an AI coach that understands their history,
- want meal-planning help,
- dislike manually organizing health documents,
- want health information consolidated into one system.

The product should work for beginners and highly engaged users.

A beginner should not feel overwhelmed.

A highly engaged user should not feel artificially limited.

---

# 6. User Health Profile

The user profile establishes stable context about the person.

## 6.1 Core Profile

The profile should support:

- Name
- Date of birth
- Sex at birth
- Height
- Preferred measurement units
- Time zone
- Optional gender identity
- Optional profile photo

Date of birth, sex at birth, and height are particularly important because they may affect:

- age-based interpretation,
- body-composition calculations,
- certain reference ranges,
- calorie estimates,
- exercise recommendations,
- health-context reasoning.

---

## 6.2 Personal Bio

The user should be able to provide a short personal bio.

Examples:

> I have a demanding corporate job and travel frequently. I want to stay healthy, maintain energy, and be active with my family.

> I am trying to lose fat while keeping muscle. I can normally train four days per week.

> I care most about longevity, cardiovascular health, and being physically strong.

The bio is not a medical record.

It is context for the AI.

---

## 6.3 Values and Priorities

The user should be able to indicate what matters most to them.

Possible values:

- Longevity
- Family
- Strength
- Appearance
- Athletic performance
- Energy
- Weight management
- Cardiovascular health
- Mobility
- Independence
- Mental wellbeing
- Stress management
- Sleep
- Convenience
- Sustainability
- Time efficiency

These values should influence recommendations.

For example, a user who prioritizes time efficiency may prefer:

- shorter workouts,
- simpler meals,
- fewer weekly commitments.

---

# 7. AI Coaching Profile

The user should be able to shape how EvoPath communicates.

## 7.1 Coaching Style

Examples:

- Supportive
- Direct
- Analytical
- Structured
- Flexible
- Motivational
- Minimalist

The user may choose one or multiple characteristics.

---

## 7.2 Communication Preferences

Possible settings:

- Concise ↔ Detailed
- Gentle ↔ Direct
- Flexible ↔ Structured
- Casual ↔ Professional
- High encouragement ↔ Minimal encouragement
- Explanatory ↔ Action-oriented

---

## 7.3 AI Context

The AI should have access to relevant context such as:

- user profile,
- age,
- sex at birth,
- height,
- goals,
- current medications,
- recent health measurements,
- body-composition history,
- recent workouts,
- current training plan,
- gym equipment,
- recent meals,
- nutrition targets,
- subjective wellness,
- user values,
- preferred coaching style.

The AI should retrieve only the context necessary for the current task rather than blindly processing everything the user has ever stored.

---

# 8. Health Measurements

EvoPath should support structured health measurements across many categories.

A general measurement can represent:

- Numeric values
- Ratios
- Percentages
- Ranges
- Ordinal values
- Categories
- Boolean values
- Text results
- Composite measurements
- Time-series measurements

Examples:

- LDL: 98 mg/dL
- Blood pressure: 118/74 mmHg
- Body fat: 19.5%
- Stress: 4/5
- Hepatitis C: Negative
- Sleep: 7 hours 22 minutes
- Pain: 3/10

---

# 9. Measurement Metadata

Each important measurement should be capable of storing contextual information such as:

- Measurement name
- Canonical measurement name
- Value
- Unit
- Date
- Time
- Reference low
- Reference high
- Interpretation
- Measurement method
- Body region if relevant
- Source
- Source document
- Source page
- User-entered notes
- AI extraction confidence
- User verification status
- Whether the value was:
  - measured,
  - reported,
  - calculated,
  - estimated,
  - manually entered,
  - device imported,
  - AI extracted

This information allows EvoPath to distinguish between a measured value and an estimate.

---

# 10. Medical Document Library

EvoPath should provide a central place for health-related files.

Possible documents:

- Blood-work reports
- DEXA reports
- Body-composition reports
- Doctor summaries
- Imaging reports
- Medical reports
- Medication lists
- Hospital discharge documents
- Physical exam reports
- Other health PDFs

Users should be able to:

- Upload a document
- View the document
- Rename the document
- Categorize the document
- Add notes
- Delete the document
- See which structured measurements were extracted from it
- Navigate from a measurement back to the source document
- Re-run extraction if needed
- Correct extracted data

The original document should remain preserved.

---

# 11. AI Document Extraction

When a medical document is uploaded, EvoPath should attempt to identify:

- document type,
- provider or facility,
- date of service,
- patient information if available,
- relevant measurements,
- units,
- reference ranges,
- interpretation flags,
- body regions,
- report metadata.

The AI should return:

- values it is confident about,
- values requiring review,
- unrecognized items,
- possible duplicates,
- extraction warnings.

The application should not silently discard unknown information.

A review experience should allow the user to:

- accept all,
- accept individual values,
- edit values,
- reject values,
- add missing values manually.

---

# 12. Biomarker Tracking

Blood work should become a major structured health area.

Examples include:

- Cholesterol
- LDL
- HDL
- Triglycerides
- A1C
- Glucose
- Insulin
- Testosterone
- Estradiol
- Vitamin D
- Liver enzymes
- Kidney markers
- CBC values
- Thyroid markers
- Iron
- Ferritin
- Electrolytes
- Inflammatory markers
- Other lab values

EvoPath should support a broad biomarker catalog without assuming that all laboratories use identical naming.

For every biomarker, the user should be able to see:

- latest value,
- previous value,
- change,
- chart over time,
- units,
- historical reference ranges,
- original source,
- manual entries,
- notes,
- user goals if applicable.

---

# 13. Reference Ranges

Reference ranges should belong to the measurement event.

EvoPath should not assume that there is always one universal normal range.

The app should distinguish between:

- laboratory-reported reference range,
- user-defined target,
- AI or guideline-based informational range when appropriate.

These should never be presented as if they are the same concept.

---

# 14. Body Composition

Body Composition should be a major domain within EvoPath.

DEXA is one method of measuring body composition, but body composition should not depend on DEXA.

---

# 15. Body Composition — Quick Entry

A user should be able to quickly log:

- Weight
- Optional body-fat percentage
- Optional waist circumference

This experience should be extremely fast.

Example:

> Weight: 208.4 lb  
> Body Fat: 27.8%  
> Save

No advanced data should be required.

---

# 16. Body Composition — Detailed Manual Entry

Users who have additional information may enter:

- Weight
- Body-fat percentage
- Fat mass
- Lean mass
- Fat-free mass
- Muscle mass
- Skeletal muscle percentage
- Body water
- Bone mass
- Visceral-fat estimate
- Waist circumference
- Hip circumference
- Waist-to-hip ratio
- Additional measurements

All fields should be optional.

---

# 17. DEXA and Advanced Body Composition

When the user uploads a DEXA scan, EvoPath should extract advanced measurements where available.

Potential measurements include:

## Overall composition

- Total mass
- Body-fat percentage
- Fat mass
- Lean mass
- Fat-free mass

## Regional fat

- Left arm fat
- Right arm fat
- Arms total fat
- Trunk fat
- Left leg fat
- Right leg fat
- Legs total fat

## Regional lean mass

- Left arm lean mass
- Right arm lean mass
- Arms total lean mass
- Trunk lean mass
- Left leg lean mass
- Right leg lean mass
- Legs total lean mass

## Muscularity

- Appendicular Lean Mass Index (ALMI)
- Fat-Free Mass Index (FFMI)

## Fat distribution

- Visceral fat
- Android fat
- Gynoid fat
- Android-to-gynoid ratio

## Skeletal metrics

- Bone Mineral Content (BMC)
- Bone Mineral Density (BMD)
- T-score
- Z-score
- Regional BMD measurements

The application should support additional measurements introduced by different DEXA providers.

---

# 18. Measurement Method

Body-composition measurements should track how they were obtained.

Possible methods:

- Manual
- Scale
- Smart scale
- Bioelectrical impedance
- DEXA
- Air displacement
- Skinfold measurement
- Hydrostatic measurement
- Other

This prevents EvoPath from treating measurements from different methods as perfectly equivalent.

Charts should be able to visually indicate the measurement source or method.

---

# 19. Derived Body-Composition Values

EvoPath may calculate additional metrics when enough data exists.

Examples:

- BMI
- Estimated fat mass
- Estimated fat-free mass
- FFMI
- Waist-to-height ratio

Calculated values must be clearly identified as calculated rather than directly measured.

---

# 20. Vital Signs and Common Health Metrics

EvoPath should support manual tracking of common health metrics.

Examples:

- Blood pressure
- Resting heart rate
- Heart rate
- Respiratory rate
- Blood oxygen
- Temperature
- Weight
- Waist circumference
- Sleep duration
- Steps
- Exercise duration

Not all of these need advanced integrations initially.

Manual entry should always be available.

---

# 21. Subjective Wellness and Check-Ins

Not every useful health measurement is laboratory-based.

Users should be able to record subjective measures.

Potential check-in metrics:

- Stress
- Energy
- Mood
- Motivation
- Hunger
- Sleep quality
- Muscle soreness
- Recovery
- Pain
- Mental focus
- Libido
- Fatigue

Examples:

> Stress: 4/5  
> Energy: 2/5  
> Sleep Quality: 3/5

The user should be able to attach notes.

Example:

> High stress because of a major work presentation.

These values should become part of the longitudinal record and may be used by the AI when relevant.

---

# 22. Medications

Medication tracking should be included in the initial EvoPath vision.

For each medication, EvoPath should support:

- Medication name
- Generic name when known
- Dose
- Dose unit
- Frequency
- Route
- Start date
- End date
- Active status
- Reason for taking the medication
- Prescribing clinician
- Notes

Possible states:

- Active
- Paused
- Stopped

---

# 23. Medication Entry Methods

Users should be able to add medications by:

- Manual entry
- Extraction from medical documents
- Photograph of a medication label
- AI-assisted recognition

AI-generated medication information must be reviewable and editable.

---

# 24. Medication Timeline

Medication changes should appear in the health timeline.

Examples:

> March 10 — Medication started  
> April 15 — Dose changed  
> June 1 — Medication stopped

The AI may identify temporal relationships between medication changes and health measurements but should not automatically claim causation.

Example:

> LDL decreased after this medication was started.

Preferred over:

> This medication caused LDL to decrease.

---

# 25. Goals

Goals are a central part of EvoPath.

Health information is more useful when the application knows what the user is trying to accomplish.

Goals should be structured and measurable whenever possible.

---

# 26. Goal Categories

Examples:

## Body composition

- Lose weight
- Gain weight
- Reduce body-fat percentage
- Increase lean mass
- Reduce waist circumference

## Strength

- Perform 10 chin-ups
- Bench press a target weight
- Increase squat strength
- Complete a certain number of dips

## Biomarkers

- Improve LDL
- Improve triglycerides
- Improve A1C
- Improve blood pressure

## Fitness

- Train four times per week
- Walk a certain number of steps
- Improve cardiovascular endurance

## Nutrition

- Reach protein target
- Reduce calorie intake
- Improve meal consistency
- Cook more meals at home

## Wellness

- Reduce stress
- Improve sleep consistency
- Improve energy

---

# 27. Goal Structure

A structured goal may contain:

- Goal type
- Target metric
- Baseline
- Current value
- Target value
- Target date
- Priority
- Status
- Notes
- Related plan
- Progress history

Example:

> Goal: Reduce body-fat percentage  
> Baseline: 29.2%  
> Current: 27.8%  
> Target: 22%  
> Target date: June 1

---

# 28. Goal Progress

EvoPath should show:

- Baseline
- Current value
- Target
- Percentage of progress
- Trend
- Time remaining
- Related activities
- Related measurements

The AI should be able to explain whether progress appears to be on track.

---

# 29. Fitness and Training

Fitness should be one of EvoPath's primary action systems.

The goal is not merely to generate random workouts.

The goal is to create and maintain structured training plans that adapt to:

- the user,
- the user's goals,
- available equipment,
- training location,
- recent workouts,
- strength history,
- time available,
- recovery and subjective wellness,
- relevant health context.

---

# 30. Workout Types

EvoPath should support several workout experiences.

## Program Workout

The user follows a structured multi-week program.

Example:

> Today's workout from my muscle-gain program.

## Ad-Hoc Workout

Example:

> I have 30 minutes. Give me a workout.

## Bodyweight Workout

Example:

> I have no equipment.

## Equipment-Constrained Workout

Example:

> I only have dumbbells and a bench.

## Location-Based Workout

Example:

> Give me today's workout using the equipment at Home Gym.

## Travel Workout

Example:

> I am at a hotel gym. Give me a 40-minute workout.

## Recovery Workout

Example:

> I am sore today. Give me a lighter session.

---

# 31. Persistent Training Programs

AI-generated workout plans should not disappear after they are generated.

A training program should have persistent structure such as:

- Program
- Training block
- Week
- Workout
- Exercise
- Set

The system should remember:

- what the user did,
- what weight was used,
- how many repetitions were completed,
- whether the exercise felt easy or difficult,
- whether the user missed a workout,
- and how performance is changing.

---

# 32. Workout Logging

For each workout, EvoPath should support:

- Workout name
- Date
- Start time
- Duration
- Location
- Program
- Notes

For each exercise:

- Exercise
- Equipment
- Target muscle groups
- Set number
- Weight
- Repetitions
- Time
- Distance if relevant
- RPE
- RIR
- Rest
- Completion status
- Pain or discomfort
- Notes

---

# 33. Training Progress

EvoPath should help users understand:

- Workout adherence
- Weekly training frequency
- Training volume
- Strength changes
- Estimated 1RM when useful
- Repetition PRs
- Weight PRs
- Exercise consistency
- Volume by muscle group
- Progress toward strength goals

---

# 34. Progressive Overload

The AI should use workout history rather than generating completely unrelated workouts every session.

Example:

Last week:

> Dumbbell Bench Press  
> 70 lb × 10  
> 70 lb × 10  
> 70 lb × 9

The next recommendation might be:

> Try 70 lb × 11, 10, 10.

The goal is for the AI to act like a persistent coach.

---

# 35. Training Locations

Users should be able to register training locations.

Examples:

- Home Gym
- Club Gym
- Office Gym
- Hotel Gym
- Apartment Gym
- Outdoor Park
- Other

A training location may include:

- Name
- Type
- Description
- Photos
- Available equipment
- Optional GPS location
- Notes

---

# 36. GPS-Aware Gym Context

A user may optionally associate a GPS location with a registered gym.

If location permissions are granted, EvoPath may detect that the user appears to be near a known gym.

The app should ask for confirmation rather than silently assuming.

Example:

> It looks like you're at Home Gym. Use Home Gym equipment for your workout?

Location awareness should be optional.

EvoPath should not require continuous location tracking.

---

# 37. Temporary Training Locations

A user should be able to use a gym without permanently registering it.

Example flow:

> I'm at a hotel gym.

The user photographs equipment.

EvoPath creates a temporary equipment context.

The AI generates the workout.

Afterwards:

> Save this gym for future use?

The user may choose yes or no.

---

# 38. Gym Equipment Catalog

Each training location should maintain a list of equipment.

Examples:

- Dumbbells
- Adjustable dumbbells
- Barbell
- Bench
- Squat rack
- Cable machine
- Smith machine
- Leg press
- Lat pulldown
- Row machine
- Leg extension
- Leg curl
- Treadmill
- Stationary bike
- Elliptical
- Pull-up bar
- Dip station
- Resistance bands
- Kettlebells

---

# 39. Equipment Capabilities

Equipment should not be represented only by brand or model name.

EvoPath should understand what movements the equipment enables.

Example:

> Functional Trainer

Possible capabilities:

- Cable row
- Cable fly
- Lat pulldown
- Triceps extension
- Curl
- Lateral raise
- Face pull
- Assisted squat variation

This enables the AI to substitute exercises intelligently.

---

# 40. Gym Equipment Photo Recognition

A user should be able to photograph a gym.

Potential workflow:

1. User selects **Scan Gym**.
2. User takes several pictures of the room.
3. AI identifies visible equipment.
4. EvoPath presents detected equipment.
5. User confirms or edits.
6. Confirmed equipment becomes part of the gym profile.
7. Photos remain attached to the gym/equipment for future reference.

The AI should never require the user to know the exact equipment model.

---

# 41. Equipment Photos

Photos should remain stored and associated with:

- gym,
- equipment,
- date,
- notes.

This allows:

- later verification,
- reclassification,
- visual identification,
- AI reasoning,
- user reference.

---

# 42. Exercise Substitution

If the planned exercise cannot be performed because required equipment is unavailable, the AI should offer substitutions.

Example:

Planned:

> Barbell Bench Press

Available equipment:

> Dumbbells + adjustable bench

Substitution:

> Dumbbell Bench Press

The substitution should attempt to preserve the purpose of the exercise.

---

# 43. Time-Aware Workouts

The user should be able to say:

> I only have 20 minutes.

The AI should modify:

- number of exercises,
- number of sets,
- rest intervals,
- exercise selection,
- workout structure.

The user should not need to abandon the program just because a particular day is short.

---

# 44. Nutrition

Nutrition should be the second major action system within EvoPath.

The nutrition system should support:

- Food logging
- Meal logging
- Meal photos
- Calories
- Macronutrients
- Meal planning
- Recipes
- Grocery planning
- Food preferences
- Goal-aware suggestions

---

# 45. Meal Record

A meal may contain:

- Date
- Time
- Meal type
- Photo
- Food items
- Calories
- Protein
- Carbohydrates
- Fat
- Fiber
- Notes
- Source
- AI confidence

Meal types may include:

- Breakfast
- Lunch
- Dinner
- Snack
- Other

---

# 46. Food Item

Each food item may contain:

- Food name
- Brand
- Restaurant
- Portion
- Quantity
- Calories
- Protein
- Carbohydrates
- Fat
- Fiber
- Additional nutrition information when available

---

# 47. Food Photo Recognition

The user should be able to take a picture of food.

The AI should attempt to identify:

- foods present,
- branded food where recognizable,
- restaurant product where recognizable,
- estimated portion size,
- estimated calories,
- estimated macros.

Example:

> This appears to be a McDonald's Big Mac.

For a known branded item, EvoPath should prefer known nutrition data rather than relying on an AI-generated estimate.

---

# 48. Homemade Food Estimation

For a meal such as:

- chicken,
- rice,
- avocado,
- vegetables,

the AI may estimate quantities.

Example:

> Chicken breast — approximately 6 oz  
> Rice — approximately 1 cup  
> Avocado — approximately 1/2  
> Vegetables — approximately 1 cup

The estimate must be presented as an estimate.

The user should be able to adjust every component.

---

# 49. Meal Photo Preservation

Meal photos should remain attached to the meal record.

This allows the user and AI to later answer questions such as:

- What did I actually eat?
- What lunches usually give me at least 50 g of protein?
- What meals have I repeated most frequently?
- Which meals fit my current calorie target?

---

# 50. Manual Food Entry

Users should never be forced to use photos.

They should be able to:

- search for food,
- add food manually,
- enter calories manually,
- enter macros manually,
- save frequently eaten items,
- copy previous meals.

---

# 51. Recipes

Recipes should be separate from meals.

A recipe represents something the user may make repeatedly.

A recipe may contain:

- Name
- Description
- Ingredients
- Quantities
- Servings
- Calories per serving
- Protein
- Carbohydrates
- Fat
- Fiber
- Preparation instructions
- Preparation time
- Photos
- Tags
- Notes

---

# 52. AI Recipe Creation

Users should be able to ask:

> Give me a dinner around 650 calories with at least 55 g of protein using chicken.

The AI can create a recipe.

The user should be able to:

- edit it,
- save it,
- cook it,
- log it as a meal,
- adjust serving size.

---

# 53. Meal Planning

EvoPath should support weekly meal plans.

The AI should consider:

- calorie target,
- protein target,
- macro preferences,
- health goals,
- food preferences,
- dietary restrictions,
- favorite meals,
- meals eaten recently,
- cooking frequency,
- available time.

The user should be able to edit the plan.

---

# 54. Meal Plan Structure

A meal plan may contain:

- Week
- Day
- Breakfast
- Lunch
- Dinner
- Snacks

The application should distinguish between:

- planned meal,
- actual meal eaten.

This makes adherence measurable.

---

# 55. Grocery Lists

A weekly meal plan should be able to generate a grocery list.

The grocery list should consolidate ingredients across recipes.

Example:

- Chicken breast
- Salmon
- Eggs
- Rice
- Potatoes
- Broccoli
- Avocados

Users should be able to:

- check items off,
- add items,
- remove items,
- modify quantities.

---

# 56. Nutrition Preferences

EvoPath should gradually learn or allow the user to explicitly provide:

- Favorite foods
- Foods disliked
- Dietary restrictions
- Allergies if tracked later
- Common restaurants
- Cooking habits
- Typical breakfast
- Typical lunch
- Preferred snacks
- Foods the user avoids

These preferences should improve future recommendations.

---

# 57. Nutrition Targets

Users may have targets such as:

- Daily calories
- Protein
- Carbohydrates
- Fat
- Fiber

Targets may be:

- manually defined,
- suggested by AI,
- associated with a goal.

Users should always be able to override them.

---

# 58. Daily Nutrition Summary

The user should see:

- Calories consumed
- Calories remaining
- Protein
- Carbohydrates
- Fat
- Fiber
- Meals logged

The display should remain understandable rather than turning nutrition into an overly complex spreadsheet.

---

# 59. AI Health Coach

The AI coach should be the intelligence layer connecting all EvoPath capabilities.

The AI coach should be able to reason across:

- health measurements,
- documents,
- medications,
- goals,
- body composition,
- workouts,
- gym equipment,
- meals,
- nutrition,
- subjective wellness,
- personal preferences.

---

# 60. AI Coach Capabilities

The user should be able to ask questions such as:

> How has my cholesterol changed?

> What changed since my last blood test?

> How much weight have I lost this year?

> Am I losing muscle?

> Compare my last two DEXA scans.

> What should I focus on this month?

> Create a workout for me today.

> I'm at Home Gym. What should I do?

> I only have dumbbells.

> I have 30 minutes.

> What should I eat for dinner?

> I have chicken, rice, and broccoli.

> Create my meal plan for next week.

> How am I doing against my body-fat goal?

> What should I discuss with my doctor at my next appointment?

The AI should answer based on the user's actual stored information whenever possible.

---

# 61. Agentic AI Concept

EvoPath should support an AI that can take actions within the application through controlled capabilities.

Examples:

- retrieve health profile,
- retrieve measurements,
- retrieve biomarker history,
- retrieve body-composition history,
- retrieve goals,
- retrieve gym equipment,
- retrieve workout history,
- retrieve meals,
- retrieve nutrition targets,
- create draft goals,
- create draft workout plans,
- create meal plans,
- compare time periods,
- summarize progress.

The AI should not have unrestricted authority over user data.

Important changes should be visible and confirmable.

---

# 62. AI Provider Choice

The EvoPath vision should not depend on a single AI provider.

The initial experience may use one provider, but the product should conceptually support different AI providers and models over time.

The user may eventually choose different models for different capabilities.

Examples:

- Document extraction model
- Health reasoning model
- Workout-planning model
- Nutrition model
- Quick classification model

The application should treat AI provider choice as a user-controlled capability rather than a fundamental part of the user's health record.

---

# 63. Bring Your Own Key

EvoPath should support a Bring Your Own Key model.

Each user may provide credentials for the AI provider they wish to use.

The user should understand:

- which provider is active,
- which model is active,
- which tasks use that provider,
- when health information may be sent to that provider.

The user should be able to:

- update credentials,
- remove credentials,
- change providers,
- change models.

---

# 64. AI Transparency

The application should communicate the difference between:

- User-provided information
- Device or document data
- Calculated values
- AI interpretations
- AI estimates
- AI recommendations

The user should never be led to believe that an estimate is a measured fact.

---

# 65. Gamification

Gamification should help users maintain healthy behaviors.

Gamification should reward behavior rather than medical outcomes that may be outside the user's direct control.

Good examples:

- Workout completed
- Protein goal reached
- Meal plan followed
- Blood pressure logged
- Weekly check-in completed
- Seven-day adherence streak
- Personal strength record
- Monthly body measurement completed
- Health document reviewed
- Goal milestone reached

---

# 66. Gamification Elements

Potential features:

- XP
- Levels
- Streaks
- Badges
- Milestones
- Weekly quests
- Progress celebrations

Example weekly quest:

> Complete 3 strength workouts  
> Reach protein target 5 days  
> Walk 40,000 steps  
> Complete Sunday check-in

Progress:

> 3 of 4 completed

---

# 67. Gamification Safety

EvoPath should avoid gamifying:

- disease,
- dangerous restriction,
- medication behavior without appropriate context,
- excessively low calorie intake,
- extreme exercise,
- biological measurements the user cannot directly control.

Gamification should reinforce healthy process and consistency.

---

# 68. Health Timeline

A Health Timeline should become a core EvoPath experience.

Example:

## September 25

DEXA Scan

- Weight: 209.5 lb
- Body Fat: 29.2%
- Lean Mass: 139.7 lb

## September 18

Blood Work

- LDL: 72
- HDL: 51
- A1C: 5.1

## September 12

Weight

- 92.1 kg

## September 5

Blood Pressure

- 118/74

## August 29

Medication

- Dose changed

The timeline should make health changes understandable chronologically.

---

# 69. Health Dashboard

The main health dashboard should summarize what matters now.

Possible areas:

- Current body weight
- Body-fat percentage
- Lean mass
- Latest blood pressure
- Resting heart rate
- Important biomarker trends
- Active goals
- Medication summary
- Today's workout
- Today's nutrition targets
- Recent progress

The dashboard should prioritize usefulness rather than displaying every available measurement.

---

# 70. Progressive Disclosure

Advanced data should not overwhelm the interface.

Example:

Main Body Composition screen:

- Weight
- Body Fat
- Lean Mass

Then:

> View Advanced Body Composition

Advanced screen:

- Regional composition
- ALMI
- FFMI
- Visceral fat
- Android/gynoid ratio
- Bone metrics

The same philosophy should apply across EvoPath.

---

# 71. Data Correction and Revision History

Users should be able to correct any structured health information.

The application should preserve revision history where practical.

Example:

> Original extracted value: 89  
> User corrected value: 98  
> Current value: 98

This is especially important for medical information.

---

# 72. Duplicate Detection

Medical data may be imported more than once.

Example:

- A user uploads an individual lab report.
- Months later, the user uploads a complete medical-record export containing the same lab.

EvoPath should attempt to detect duplicates using factors such as:

- test name,
- date,
- value,
- unit,
- provider,
- source document.

The user should be able to decide whether similar records are duplicates.

---

# 73. Health Safety Principles

EvoPath should help users understand and improve their health, but it should not pretend to replace physicians.

The product should distinguish between:

- education,
- wellness guidance,
- exercise planning,
- nutrition planning,
- health trend explanation,
- medical diagnosis,
- medical treatment decisions.

The initial product should focus on:

- tracking,
- understanding,
- goal setting,
- wellness,
- fitness,
- nutrition,
- behavior change.

---

# 74. Urgent Health Situations

If the user provides information suggesting a potentially urgent medical situation, EvoPath should not continue with ordinary coaching as if nothing is wrong.

The application should be capable of providing conservative safety guidance.

AI personality settings must not override safety behavior.

---

# 75. Workout Safety

Workout recommendations should consider relevant user information when available.

Examples:

- Pain
- Injury
- Recovery
- Recent training load
- User limitations
- Relevant health constraints

The system should avoid encouraging users to ignore significant pain or warning signs.

---

# 76. Nutrition Safety

Nutrition recommendations should avoid promoting extreme or unsafe behavior.

The user should remain in control of calorie and macro targets.

Health-related nutrition guidance should clearly distinguish general wellness guidance from medical nutrition therapy.

---

# 77. Privacy and User Control

The application contains highly sensitive personal information.

The user should have strong control over:

- uploaded documents,
- health measurements,
- photos,
- medications,
- workouts,
- meals,
- AI credentials,
- AI-provider access.

The product should make privacy understandable.

---

# 78. AI Data Sharing Transparency

Before health information is processed by an external AI provider, users should understand that relevant data may be sent to that provider.

Where practical, EvoPath should avoid sending unrelated health information.

Example:

A request to identify gym equipment should not require sending the user's complete blood-work history.

A meal photo should not require the user's entire medical document library.

---

# 79. User Data Ownership

The user should be able to:

- view their data,
- edit their data,
- export their data,
- delete their data,
- remove documents,
- remove photos,
- revoke AI-provider credentials.

The product should behave as if the health record belongs to the user.

---

# 80. Important End-to-End User Experiences

## 80.1 New User

1. User creates an account.
2. User enters:
   - birthday,
   - sex at birth,
   - height,
   - preferred units.
3. User optionally enters a short bio.
4. User selects health priorities.
5. User selects AI coaching preferences.
6. User creates an initial goal.
7. User may begin by:
   - logging weight,
   - uploading blood work,
   - uploading DEXA,
   - adding medications,
   - creating a workout plan,
   - logging food.

The user should receive value without needing to complete every section.

---

## 80.2 Upload Blood Work

1. User uploads PDF.
2. EvoPath classifies the document.
3. AI extracts biomarkers.
4. User sees detected values.
5. User reviews questionable values.
6. User confirms.
7. Measurements are stored.
8. Each measurement links back to the PDF.
9. Dashboard and trends update.
10. AI may summarize important changes.

---

## 80.3 Upload DEXA

1. User uploads DEXA.
2. EvoPath detects body-composition metrics.
3. Core values appear first.
4. Advanced metrics are available separately.
5. User confirms or edits values.
6. DEXA is added to Body Composition history.
7. AI compares it with previous measurements.
8. Goals update.

---

## 80.4 Manual Weight Entry

1. User selects **Log Weight**.
2. User enters weight.
3. User optionally enters body fat.
4. User saves.
5. Trend updates.

This should take seconds.

---

## 80.5 Create Workout Program

1. User selects a goal.
2. User specifies:
   - days available,
   - workout duration,
   - preferred location,
   - relevant limitations.
3. AI considers:
   - profile,
   - goals,
   - body composition,
   - training history,
   - available equipment.
4. AI creates a program.
5. User reviews and edits.
6. Program becomes persistent.
7. Workouts are logged.
8. Program adapts over time.

---

## 80.6 Arrive at Hotel Gym

1. User selects **I need a workout**.
2. EvoPath detects or asks for location.
3. No known gym is available.
4. User selects **Scan equipment**.
5. User photographs the room.
6. AI detects equipment.
7. User confirms.
8. EvoPath generates workout.
9. Workout is logged.
10. App asks whether to save gym profile.

---

## 80.7 Log Meal With Photo

1. User photographs meal.
2. AI identifies foods.
3. AI estimates portions.
4. Known branded foods may match known nutrition.
5. EvoPath estimates calories/macros.
6. User reviews.
7. User edits if necessary.
8. Meal is saved.
9. Photo remains attached.
10. Daily nutrition totals update.

---

## 80.8 Plan the Week

1. User requests weekly meal plan.
2. AI considers:
   - goals,
   - calorie target,
   - protein target,
   - food preferences,
   - recent meals.
3. AI creates plan.
4. User edits.
5. EvoPath generates grocery list.
6. User follows plan.
7. Actual meals are compared to planned meals.

---

# 81. Initial Product Scope

The initial EvoPath product should focus deeply on a coherent set of capabilities rather than trying to become a complete healthcare platform immediately.

Initial core domains:

## Profile

- Date of birth
- Sex at birth
- Height
- Units
- Personal bio
- Values
- AI personality preferences

## Health

- Manual health observations
- Biomarker tracking
- Blood-work PDFs
- Body composition
- DEXA
- Blood pressure
- Heart rate
- Subjective wellness
- Medications

## Goals

- Structured goals
- Progress tracking

## Fitness

- Workout plans
- Workout logging
- Programs
- Gyms
- Equipment
- Equipment photos
- AI gym scanning
- GPS-aware gym context

## Nutrition

- Meal logging
- Meal photos
- AI food recognition
- Calories/macros
- Recipes
- Meal plans
- Grocery lists

## AI

- Health explanation
- Goal planning
- Workout creation
- Nutrition planning
- Longitudinal analysis
- Bring Your Own Key
- Provider/model choice
- User-controlled AI personality

## Engagement

- Gamification
- Streaks
- Milestones
- Progress summaries

---

# 82. Explicitly Deferred Areas

The following are valuable future opportunities but do not need to dominate the initial product vision:

- Direct EHR integrations
- Physician portals
- Family/caregiver accounts
- Genetics
- CGM-specific features
- Lab ordering
- Insurance integration
- Appointment scheduling
- Provider messaging
- Clinical decision support
- Direct medical diagnosis
- Direct medical treatment recommendations
- Advanced preventive-care orchestration
- Full clinical interoperability
- Social network features

These areas can be considered after the core EvoPath experience is strong.

---

# 83. What Makes EvoPath Different

EvoPath should not attempt to win because it has one more health metric than competing apps.

The differentiation should come from the **closed-loop improvement system**.

Other tools may tell the user:

> Your body fat is 29%.

EvoPath should help answer:

> Your body fat is 29%.  
> Your goal is 22%.  
> Your lean mass is important to preserve.  
> Here is the training program designed around that goal.  
> Here is your protein target.  
> Here is your meal plan.  
> Here is what you actually ate.  
> Here is what you actually trained.  
> Here is your adherence.  
> Here is your next measurement.  
> Here is what changed.  
> Here is how the plan should be adjusted.

The product's identity should be built around this loop.

---

# 84. EvoPath's Core Intelligence Model

The AI should understand five major questions.

## 84.1 Who is this person?

- Age
- Sex
- Height
- Bio
- Values
- Preferences
- Medications
- Health history

## 84.2 Where are they now?

- Biomarkers
- Body composition
- Weight
- Blood pressure
- Fitness
- Nutrition
- Wellness

## 84.3 Where do they want to go?

- Weight goal
- Body-fat goal
- Muscle goal
- Strength goal
- Nutrition goal
- Health goal

## 84.4 What are they currently doing?

- Workout program
- Workout adherence
- Meals
- Nutrition adherence
- Medications
- Check-ins

## 84.5 Is it working?

- Trend
- Progress
- Adherence
- New measurements
- DEXA changes
- Lab changes
- Strength changes
- Body-weight changes
- User experience

This framework should guide how EvoPath uses AI.

---

# 85. Personal Baseline

Even though advanced baseline analytics may come later, EvoPath should preserve enough history to understand the user's personal normal.

Examples:

- Typical resting heart rate
- Typical blood pressure
- Typical body weight
- Typical stress
- Typical workout frequency
- Typical protein intake

The user should eventually be able to ask:

> Is this unusual for me?

rather than only:

> Is this normal for the general population?

---

# 86. Source Hierarchy and Trust

When multiple sources contain similar data, EvoPath should preserve source identity.

Example:

Body fat measurements may come from:

- DEXA
- Smart scale
- Manual entry

They should not be silently merged as though they are identical.

The system should be capable of showing:

> 29.2% — DEXA  
> 27.8% — Smart scale

The user can understand that method differences may affect the values.

---

# 87. Photos as Evidence

Photos are an important part of EvoPath.

Possible photo types:

- Gym equipment
- Meal
- Medication label
- Progress photo
- Document photo
- Other health reference image

Photos should remain linked to the object they helped create.

This allows future review and AI re-analysis.

---

# 88. Manual Entry Everywhere

Every core domain should support manual entry.

Examples:

- Manually enter lab result
- Manually enter body composition
- Manually enter blood pressure
- Manually enter medication
- Manually create gym
- Manually add equipment
- Manually create workout
- Manually log meal
- Manually enter calories
- Manually create recipe
- Manually create goal

AI should accelerate the experience, not make the application dependent on AI.

---

# 89. Editing Everywhere

Every AI-assisted object should be editable.

Examples:

- extracted biomarker,
- DEXA measurement,
- medication,
- equipment,
- food,
- meal,
- recipe,
- workout,
- training program,
- goal.

This is a foundational rule.

---

# 90. User Experience Principle: Do Not Force Completion

The application should not require the user to fill out every field before receiving value.

Examples:

A user can have:

- a weight record without body-fat percentage,
- a workout without heart-rate data,
- a meal without perfect macros,
- a gym without GPS,
- a medication without prescribing clinician,
- a goal without a target date.

Partial but truthful data is better than invented data.

---

# 91. User Experience Principle: Preserve Momentum

Common tasks should be fast.

Examples:

- Log weight
- Log blood pressure
- Mark workout complete
- Add set
- Photograph meal
- Add medication
- Complete check-in

Advanced functionality should remain available without slowing down everyday actions.

---

# 92. User Experience Principle: AI Should Reduce Work

AI should be used where it meaningfully reduces user effort.

High-value uses include:

- Medical document extraction
- DEXA extraction
- Medication recognition
- Equipment recognition
- Food recognition
- Workout planning
- Meal planning
- Recipe creation
- Progress summaries
- Health trend explanation

AI should not be added merely for novelty.

---

# 93. User Experience Principle: Never Hide Uncertainty

If AI is uncertain, EvoPath should say so.

Examples:

> I think this is a leg-extension machine.

> This meal appears to contain approximately 6–8 oz of chicken.

> This value may be 98 mg/dL, but the PDF is difficult to read.

The user should be invited to confirm.

---

# 94. Progress Reviews

EvoPath should eventually provide recurring progress summaries.

Examples:

## Weekly Review

- Workouts completed
- Nutrition adherence
- Protein average
- Weight change
- Goal progress
- Check-in trends
- Wins
- Areas needing attention
- Suggested focus for next week

## Monthly Review

- Body composition
- Weight trend
- Strength changes
- Nutrition consistency
- Relevant biomarkers
- Goal status
- Suggested adjustments

The review should be based on actual data.

---

# 95. AI Coaching Example

A strong EvoPath interaction might look like this:

> **User:** What should I focus on this month?

EvoPath may consider:

- Body-fat goal
- Recent DEXA
- Lean-mass trend
- Workout adherence
- Protein intake
- Stress
- Available training schedule

Response:

> Your primary objective is reducing body fat while preserving lean mass. Your recent training adherence is good, but your average protein intake has been below the target you set. I would keep your current strength program, prioritize protein consistency, and avoid increasing cardio enough to interfere with recovery. We can reassess after your next body-composition measurement.

The important point is that the response comes from the user's actual context.

---

# 96. Fitness Example

> **User:** Give me a workout.

EvoPath may ask or infer:

- location,
- equipment,
- available time,
- current program,
- recent workouts,
- goal.

If the user is at a registered gym:

> You're at Home Gym and have 35 minutes. Today's program calls for upper body. I'll use your dumbbells, adjustable bench, and cable station.

The workout is then logged into the same training history.

---

# 97. Nutrition Example

> **User:** What should I eat tonight?

EvoPath may consider:

- calories remaining,
- protein remaining,
- foods already eaten,
- user preferences,
- current goal.

Response:

> You have approximately 700 calories remaining and are 55 g short of your protein target. A chicken-and-rice bowl with vegetables would fit well.

The user may ask EvoPath to generate the recipe and log it.

---

# 98. Core Product Metrics

Success should not be measured only by app opens.

Useful product success indicators may include:

- Percentage of uploaded documents successfully converted into structured data
- Percentage of AI-extracted values confirmed without correction
- Number of users maintaining longitudinal health records
- Number of users with active goals
- Workout adherence
- Meal logging consistency
- Goal progress
- Repeat use of AI coaching
- Number of users revisiting trends
- Number of users who complete measurement → plan → reassessment cycles
- User trust in extracted data
- User retention

The most meaningful long-term metric is whether users repeatedly use EvoPath to understand and improve their health.

---

# 99. Product Principles Summary

EvoPath should consistently follow these principles:

1. **The user owns the health record.**
2. **AI assists; the user remains in control.**
3. **Every important health value should have a source.**
4. **Manual entry should always be possible.**
5. **AI-generated information should always be editable.**
6. **Simple workflows should stay simple.**
7. **Advanced data should remain available when needed.**
8. **Health information should be longitudinal.**
9. **Plans should persist over time.**
10. **Workout recommendations should respect real equipment and context.**
11. **Nutrition guidance should reflect actual goals and preferences.**
12. **Gamification should reward healthy behavior, not disease outcomes.**
13. **AI personality affects communication, not truth or safety.**
14. **Uncertainty should be visible.**
15. **The application should connect measurement to action.**

---

# 100. North Star

EvoPath should become the place where a person can answer:

> **Where am I with my health, what am I trying to improve, what should I do next, and is it actually working?**

The product should connect:

> **Health Data → Understanding → Goals → Action → Progress**

The long-term vision is not simply to create another health tracker.

The long-term vision is to create an intelligent, user-controlled system that helps people continuously understand and improve their health over years.

**EvoPath is the user's path of health evolution.**
