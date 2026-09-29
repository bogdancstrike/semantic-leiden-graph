import pytest

from tests.fakes import make_container


@pytest.fixture
def container():
    c = make_container()
    yield c
    c.close()
