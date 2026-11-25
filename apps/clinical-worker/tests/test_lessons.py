"""What Watson learns from a doctor's corrections (plan step 4, 25 Nov 2026): habits, never facts."""

from clinical_worker.lessons import Edit, derive, render

LABELS = {"assessment": "Assessment", "referral": "Referral or tests", "diet": "Diet"}


def test_a_word_the_doctor_replaces_in_two_consultations_becomes_a_lesson() -> None:
    edits = [
        Edit(
            "assessment", "Pitta imbalance with heartburn", "Pitta vitiation with heartburn", "c1"
        ),
        Edit("assessment", "Vata imbalance", "Vata vitiation", "c2"),
    ]
    lessons = derive(edits, answered={"assessment": 2}, cleared={}, labels=LABELS)
    assert [(lesson.key, lesson.rule) for lesson in lessons] == [
        ("word:imbalance>vitiation", 'Write "vitiation", not "imbalance".')
    ]
    assert lessons[0].said == 'You write "vitiation" where Watson wrote "imbalance".'


def test_one_patients_details_never_become_a_lesson() -> None:
    # The same change twice in one consultation, and numbers anywhere: a fact, not a habit.
    edits = [
        Edit("medicines", "Omeprazole daily", "Pantoprazole daily", "c1"),
        Edit("assessment", "Omeprazole helps", "Pantoprazole helps", "c1"),
        Edit("medicines", "20 mg in the morning", "40 mg in the morning", "c2"),
        Edit("diet", "two coffees", "2 coffees", "c3"),
        Edit("diet", "three coffees", "3 coffees", "c4"),
    ]
    assert derive(edits, answered={}, cleared={}, labels=LABELS) == []


def test_a_word_the_doctor_also_lets_stand_is_a_correction_never_a_habit() -> None:
    # Watson misheard "right" twice; elsewhere the doctor kept "left". Flipping it would be a lie.
    edits = [
        Edit("other", "Pain in the left knee", "Pain in the right knee", "c1"),
        Edit("other", "Left shoulder stiff", "Right shoulder stiff", "c2"),
    ]
    assert [x.key for x in derive(edits, {}, {}, LABELS)] == ["word:left>right"]
    assert derive(edits, {}, {}, LABELS, kept={"left", "hip"}) == []


def test_a_question_the_doctor_nearly_always_clears_is_left_empty() -> None:
    lessons = derive(
        [], answered={"referral": 4, "diet": 4}, cleared={"referral": 3, "diet": 1}, labels=LABELS
    )
    assert [(lesson.key, lesson.rule) for lesson in lessons] == [
        (
            "empty:referral",
            "referral: leave it empty unless the practitioner says it in so many words.",
        )
    ]
    assert (
        lessons[0].said
        == 'You usually clear "Referral or tests": Watson fills it only when you say it.'
    )


def test_answers_the_doctor_shortens_or_lengthens_set_how_long_to_write() -> None:
    edits = [
        Edit(
            "diet",
            "Breakfast of porridge, coffee at ten and eleven, cold drinks at lunch",
            "Porridge, coffee, cold drinks",
            f"c{n}",
        )
        for n in range(3)
    ]
    edits += [
        Edit("assessment", "Vata", "Vata high, with dry skin and poor sleep", f"d{n}")
        for n in range(3)
    ]
    lessons = derive(edits, answered={}, cleared={}, labels=LABELS)
    assert sorted((lesson.key, lesson.rule) for lesson in lessons) == [
        ("long:assessment", "assessment: write it in full, with the detail the practitioner gave."),
        ("short:diet", "diet: keep it short, a few words."),
    ]


def test_lessons_are_few_and_forgotten_ones_stay_out() -> None:
    edits = [
        Edit("assessment", f"old{letter} here", f"new{letter} here", c)
        for letter in "abcdefghijklmnopqrst"
        for c in ("c1", "c2")
    ]
    lessons = derive(edits, answered={}, cleared={}, labels=LABELS)
    assert len(lessons) == 12
    kept = derive(edits, answered={}, cleared={}, labels=LABELS, forgotten={lessons[0].key})
    assert lessons[0].key not in {lesson.key for lesson in kept}


def test_the_prompt_says_how_the_doctor_writes_and_nothing_when_there_is_nothing() -> None:
    lessons = derive([], answered={"referral": 3}, cleared={"referral": 3}, labels=LABELS)
    assert render(lessons) == (
        "\n- How this practitioner writes, learned from their corrections (habits, never facts about this patient):"
        "\n  - referral: leave it empty unless the practitioner says it in so many words."
    )
    assert render([]) == ""
